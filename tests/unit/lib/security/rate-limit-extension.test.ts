/**
 * Tests: App-extensible rate-limit registry (fork-readiness seam 13)
 *
 * Covers the three things the seam adds:
 *   1. Tier registry — `registerRateLimitTier` / `resolveRateLimitTier`, and
 *      its refusal to shadow built-in tiers.
 *   2. Rule registry — `registerRateLimitRule`'s SECURITY guard (app rules may
 *      not match Sunrise-protected surfaces) and its insertion position
 *      (after every Sunrise rule, before the catch-all).
 *   3. End-to-end — `applyRateLimit` actually resolves an app tier and applies
 *      an app rule's cap (verified by exhausting a real bucket, not a mock).
 *
 * The registries are module-level singletons; `__reset*` helpers restore the
 * built-in baseline after each test so cases stay independent.
 *
 * @see lib/security/rate-limit.ts
 * @see lib/security/rate-limit-policy.ts
 * @see lib/security/rate-limit-middleware.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth + logging so importing the middleware doesn't pull in real
// better-auth / DB wiring. The 'ip'-keyed app rule below never calls
// getSession, but the dispatcher imports the module regardless.
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createRateLimiter,
  registerRateLimitTier,
  resolveRateLimitTier,
  __resetAppRateLimitTiers,
  RATE_LIMIT_TIERS,
} from '@/lib/security/rate-limit';
import {
  registerRateLimitRule,
  getEffectiveRateLimitPolicy,
  findRateLimitRule,
  RATE_LIMIT_POLICY,
  __resetAppRateLimitRules,
  type RateLimitRule,
} from '@/lib/security/rate-limit-policy';
import { applyRateLimit } from '@/lib/security/rate-limit-middleware';

function makeLimiter(maxRequests: number) {
  return createRateLimiter({ interval: 60_000, maxRequests });
}

afterEach(() => {
  __resetAppRateLimitRules();
  __resetAppRateLimitTiers();
});

// ─── Tier registry ─────────────────────────────────────────────────────────

describe('registerRateLimitTier / resolveRateLimitTier', () => {
  it('resolves built-in tiers without any registration', () => {
    // The registry is seeded from RATE_LIMIT_TIERS, holding the SAME instances.
    expect(resolveRateLimitTier('admin')).toBe(RATE_LIMIT_TIERS.admin);
    expect(resolveRateLimitTier('api')).toBe(RATE_LIMIT_TIERS.api);
    expect(resolveRateLimitTier('mcp')).toBe(RATE_LIMIT_TIERS.mcp);
  });

  it('registers an app tier and resolves it to the same limiter instance', () => {
    const limiter = makeLimiter(7);
    registerRateLimitTier('billing', limiter);
    expect(resolveRateLimitTier('billing')).toBe(limiter);
  });

  it('returns undefined for an unknown tier name', () => {
    expect(resolveRateLimitTier('does-not-exist')).toBeUndefined();
  });

  it('refuses to override a built-in tier (security: cannot loosen admin/auth/etc.)', () => {
    // Registering 'admin' with a looser limiter would silently weaken the
    // 30/min core-admin cap — the registry must reject it.
    expect(() => registerRateLimitTier('admin', makeLimiter(10_000))).toThrow(/built-in/i);
    // The built-in instance is untouched.
    expect(resolveRateLimitTier('admin')).toBe(RATE_LIMIT_TIERS.admin);
  });

  it('rejects a duplicate app-tier registration', () => {
    registerRateLimitTier('billing', makeLimiter(7));
    expect(() => registerRateLimitTier('billing', makeLimiter(9))).toThrow(/already registered/i);
  });

  it('rejects an empty tier name', () => {
    expect(() => registerRateLimitTier('', makeLimiter(1))).toThrow();
  });
});

// ─── Rule registry — security guard ──────────────────────────────────────────

describe('registerRateLimitRule — protected-namespace guard', () => {
  const protectedMatchers: Array<[string, RegExp | string]> = [
    ['core admin (regex)', /^\/api\/v1\/admin\//],
    ['orchestration admin', /^\/api\/v1\/admin\/orchestration\//],
    ['better-auth credential surface', /^\/api\/auth\//],
    ['Sunrise app-layer auth', /^\/api\/v1\/auth\//],
    ['MCP transport', /^\/api\/v1\/mcp(\/|$)/],
    ['overly-broad /api/v1 (shadows admin)', /^\/api\/v1\//],
    ['overly-broad /api (shadows auth)', /^\/api\//],
    ['admin string prefix', '/api/v1/admin/'],
    ['catch-all regex', /.*/],
  ];

  it.each(protectedMatchers)(
    'rejects a rule whose matcher could fire for the %s',
    (_label, match) => {
      // Act & Assert — registration throws...
      expect(() => registerRateLimitRule({ match, tier: 'api', key: 'ip' })).toThrow(
        /shadow|protected/i
      );
      // ...and the rejected rule was NOT added (effective policy === base by identity).
      expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
    }
  );

  it('accepts a rule scoped to the app’s own /api/v1 namespace', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'session-user' });
    // It was added — effective policy is no longer the base array by identity.
    expect(getEffectiveRateLimitPolicy()).not.toBe(RATE_LIMIT_POLICY);
  });
});

// ─── Rule registry — insertion position ──────────────────────────────────────

describe('getEffectiveRateLimitPolicy — insertion position', () => {
  it('returns the base policy by identity when no app rules are registered', () => {
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('splices an app rule immediately before the catch-all, after all Sunrise rules', () => {
    const appRule: RateLimitRule = {
      match: /^\/api\/v1\/billing\//,
      tier: 'api',
      key: 'session-user',
    };
    registerRateLimitRule(appRule);
    const eff = getEffectiveRateLimitPolicy();

    // Exactly one rule added.
    expect(eff).toHaveLength(RATE_LIMIT_POLICY.length + 1);
    // Catch-all (session-user /^\/api\/v1\//) remains the LAST rule.
    const baseCatchAll = RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1];
    expect(eff[eff.length - 1]).toBe(baseCatchAll);
    // App rule sits immediately ahead of the catch-all.
    expect(eff[eff.length - 2]).toBe(appRule);
    // Every Sunrise specific rule still precedes the app rule, unchanged & in order.
    expect(eff.slice(0, RATE_LIMIT_POLICY.length - 1)).toEqual(RATE_LIMIT_POLICY.slice(0, -1));
  });

  it('app rule wins over the catch-all for the app namespace (first-match-wins)', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'api-key' });
    const rule = findRateLimitRule('/api/v1/billing/charge', getEffectiveRateLimitPolicy());
    // Resolves to the app rule's keying, NOT the session-user catch-all.
    expect(rule?.key).toBe('api-key');
  });

  it('does not change resolution for Sunrise-owned paths', () => {
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'api', key: 'api-key' });
    const eff = getEffectiveRateLimitPolicy();
    expect(findRateLimitRule('/api/v1/admin/users', eff)?.tier).toBe('admin');
    expect(findRateLimitRule('/api/v1/mcp', eff)?.tier).toBe('mcp');
    // A generic api path still lands on the session-user catch-all.
    expect(findRateLimitRule('/api/v1/unrelated/thing', eff)?.key).toBe('session-user');
  });
});

// ─── End-to-end: middleware applies an app tier + rule ───────────────────────

describe('applyRateLimit — enforces an app-registered tier + rule', () => {
  beforeEach(() => {
    // tests/setup.ts sets RATE_LIMIT_BYPASS=true globally; clear it so the
    // dispatcher runs for real. Vitest auto-restores after the test.
    vi.stubEnv('RATE_LIMIT_BYPASS', '');
    vi.clearAllMocks();
  });

  it('resolves the app tier and enforces its cap (not the api default)', async () => {
    // Arrange — an app tier capped at 2/min, wired to an app path.
    registerRateLimitTier('billing', makeLimiter(2));
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'ip' });

    const headers = { 'x-forwarded-for': '192.0.2.200' };
    const make = (): NextRequest =>
      new NextRequest('http://localhost:3000/api/v1/billing/charge', { headers });

    // Act + Assert — first two requests pass...
    expect(await applyRateLimit(make())).toBeNull();
    expect(await applyRateLimit(make())).toBeNull();

    // ...the third is rejected AT THE APP CAP OF 2 (proving the app tier was
    // resolved — the api default of 100 would have let it through).
    const blocked = await applyRateLimit(make());
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('X-RateLimit-Limit')).toBe('2');
  });

  it('keeps Sunrise paths on their built-in tier even with an app rule registered', async () => {
    // Arrange — register an unrelated app rule, then hit a core admin path.
    registerRateLimitTier('billing', makeLimiter(2));
    registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'ip' });
    const userId = `user_ext_${Date.now()}`;
    vi.mocked((await import('@/lib/auth/config')).auth.api.getSession).mockResolvedValue({
      user: { id: userId },
    } as never);
    RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);

    // Act — a core admin request still resolves to the 30/min admin tier.
    const res = await applyRateLimit(
      new NextRequest('http://localhost:3000/api/v1/admin/users', {
        headers: { 'x-forwarded-for': '192.0.2.201' },
      })
    );

    // Assert — under cap, passes; the app rule didn't perturb Sunrise routing.
    expect(res).toBeNull();
    RATE_LIMIT_TIERS.admin.reset(`mw:admin:session-user:user:${userId}`);
  });
});
