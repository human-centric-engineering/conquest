/**
 * Unit Tests: Security Constants — envInt env-var overrides
 *
 * The internal `envInt(name, fallback)` helper (unexported) has three code paths:
 *   1. `!raw` (env var unset)                   → return fallback  [covered by most tests]
 *   2. `raw` present, parses to NaN or ≤ 0       → return fallback  [paths 2–3 were uncovered]
 *   3. `raw` present, parses to a positive int   → return parsed value
 *
 * `envInt` is observable only through `SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.*`
 * because the function itself is not exported. The module evaluates at first
 * import, so each test uses `vi.resetModules()` + a dynamic `import()` to get
 * a fresh module instance with whatever env state the test arranges.
 *
 * Tests use `RATE_LIMIT_API` as the probe for paths 2 & 3 (avoiding ADMIN /
 * ORCH_ADMIN / MCP unless independence is the thing being verified). Default
 * values:
 *   RATE_LIMIT_API        → 100
 *   RATE_LIMIT_ADMIN      → 30
 *   RATE_LIMIT_ORCH_ADMIN → 120
 *   RATE_LIMIT_MCP        → 300
 *
 * @see lib/security/constants.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('SECURITY_CONSTANTS.RATE_LIMIT.LIMITS — envInt env-var overrides', () => {
  // ── Snapshot every RATE_LIMIT_* var so tests that set new ones don't leak ──
  // Multiple LIMITS.* now route through envInt (tiers AND per-flow caps), so a
  // per-key save list would rot; snapshot the whole RATE_LIMIT_* namespace.
  let savedRateLimitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedRateLimitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('RATE_LIMIT_')) savedRateLimitEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Delete any RATE_LIMIT_* a test added, then restore the snapshot exactly.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('RATE_LIMIT_') && !(key in savedRateLimitEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedRateLimitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    // Always reset modules after each test so the next test's import is fresh.
    vi.resetModules();
  });

  // ── Path 1: env var unset → fallback ─────────────────────────────────────

  it('uses the hardcoded default when the env var is unset', async () => {
    // Arrange: explicitly unset so there's no residual value from test setup
    delete process.env.RATE_LIMIT_API;
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: the default for API is 100, proving `!raw → return fallback`
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 3: env var set to a valid positive integer → parsed value ────────

  it('uses the env-var value when set to a positive integer', async () => {
    // Arrange
    process.env.RATE_LIMIT_API = '500';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: parsed value 500 was used — NOT the fallback 100.
    // This is the transformation the envInt() function performs; asserting
    // the exact integer proves the parseInt path ran, not just that the
    // module loaded without error.
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(500);
  });

  // ── Path 2a: env var present but non-numeric → fallback ──────────────────

  it('falls back to the default when the env var is non-numeric', async () => {
    // Arrange: parseInt('not-a-number') → NaN; Number.isFinite(NaN) is false
    process.env.RATE_LIMIT_API = 'not-a-number';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: NaN branch returns the fallback, not 0 or NaN
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 2b: env var present but zero → fallback ──────────────────────────

  it('falls back to the default when the env var is zero', async () => {
    // Arrange: parseInt('0') → 0; 0 > 0 is false → fallback
    process.env.RATE_LIMIT_API = '0';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: zero is explicitly rejected by the `n > 0` guard
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── Path 2c: env var present but negative → fallback ─────────────────────

  it('falls back to the default when the env var is negative', async () => {
    // Arrange: parseInt('-5') → -5; -5 > 0 is false → fallback
    process.env.RATE_LIMIT_API = '-5';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: negative values are rejected
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(100);
  });

  // ── MCP default ──────────────────────────────────────────────────────────

  it('uses the documented 300/min default for MCP when the env var is unset', async () => {
    // Arrange: MCP defaults to 300 — a deliberate uplift over the api tier
    // (100) because MCP is server-to-server agent traffic, not human-paced.
    // This test pins the documented default so a stray edit to the constant
    // is caught immediately.
    delete process.env.RATE_LIMIT_MCP;
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(300);
  });

  it('applies the env override to MCP when set to a positive integer', async () => {
    // Arrange
    process.env.RATE_LIMIT_MCP = '1500';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: env var routes through the shared envInt() helper, so a positive
    // integer is parsed exactly the same as for ADMIN / API / ORCH_ADMIN.
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(1500);
  });

  // ── ADMIN, ORCH_ADMIN, and MCP are overridden independently ──────────────

  it('applies the override independently to API, ADMIN, ORCH_ADMIN, and MCP limits', async () => {
    // Arrange: set distinct values for each of the four overrideable limits.
    // This guards against a future refactor accidentally sharing state across
    // the envInt() invocations.
    process.env.RATE_LIMIT_API = '200';
    process.env.RATE_LIMIT_ADMIN = '60';
    process.env.RATE_LIMIT_ORCH_ADMIN = '240';
    process.env.RATE_LIMIT_MCP = '600';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: each env var is parsed independently — not sharing state
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API).toBe(200);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.ADMIN).toBe(60);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.ORCH_ADMIN).toBe(240);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.MCP).toBe(600);
  });

  // ── Auth tier + per-flow caps are now env-tunable too (seam 13) ───────────

  it('keeps AUTH and the per-flow caps at their defaults when their env vars are unset', async () => {
    // Arrange: setting only the section-tier vars must not bleed into the
    // newly-tunable auth tier or per-flow caps — each reads its OWN env var.
    process.env.RATE_LIMIT_API = '999';
    process.env.RATE_LIMIT_ADMIN = '999';
    delete process.env.RATE_LIMIT_AUTH;
    delete process.env.RATE_LIMIT_PASSWORD_RESET;
    delete process.env.RATE_LIMIT_CONTACT;
    delete process.env.RATE_LIMIT_IMAGE;
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: documented defaults hold when the specific override is absent
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.AUTH).toBe(5);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.PASSWORD_RESET).toBe(3);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.CONTACT).toBe(5);
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.IMAGE).toBe(20);
  });

  it('applies RATE_LIMIT_AUTH to the auth tier when set to a positive integer', async () => {
    // Arrange: the auth tier (OWASP brute-force cap) gained an env override.
    process.env.RATE_LIMIT_AUTH = '12';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: parsed value wins over the hardcoded 5
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.AUTH).toBe(12);
  });

  it('routes each per-flow cap through its own RATE_LIMIT_* override independently', async () => {
    // Arrange: distinct values per cap guard against shared-state bugs in the
    // envInt() invocations and prove the names map 1:1.
    process.env.RATE_LIMIT_PASSWORD_RESET = '7';
    process.env.RATE_LIMIT_CONTACT = '9';
    process.env.RATE_LIMIT_ACCEPT_INVITE = '11';
    process.env.RATE_LIMIT_UPLOAD = '13';
    process.env.RATE_LIMIT_INVITE = '15';
    process.env.RATE_LIMIT_CSP_REPORT = '17';
    process.env.RATE_LIMIT_CHAT = '19';
    process.env.RATE_LIMIT_CONSUMER_CHAT = '21';
    process.env.RATE_LIMIT_AUDIO = '23';
    process.env.RATE_LIMIT_EXPORT = '25';
    process.env.RATE_LIMIT_IMAGE = '27';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');
    const limits = SECURITY_CONSTANTS.RATE_LIMIT.LIMITS;

    // Assert: each cap reflects its own env var
    expect(limits.PASSWORD_RESET).toBe(7);
    expect(limits.CONTACT).toBe(9);
    expect(limits.ACCEPT_INVITE).toBe(11);
    expect(limits.UPLOAD).toBe(13);
    expect(limits.INVITE).toBe(15);
    expect(limits.CSP_REPORT).toBe(17);
    expect(limits.CHAT).toBe(19);
    expect(limits.CONSUMER_CHAT).toBe(21);
    expect(limits.AUDIO).toBe(23);
    expect(limits.EXPORT).toBe(25);
    expect(limits.IMAGE).toBe(27);
  });

  it('falls back to the per-flow default when its override is non-numeric', async () => {
    // Arrange: same NaN-guard path the tiers use, but for a per-flow cap.
    process.env.RATE_LIMIT_UPLOAD = 'lots';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');

    // Assert: invalid override → documented default (10)
    expect(SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.UPLOAD).toBe(10);
  });

  // ── Time-window constants stay fixed (not env-tunable) ────────────────────

  it('leaves the *_INTERVAL windows hardcoded (intervals are not env-tunable)', async () => {
    // Arrange: even with caps overridden, the OWASP-aligned windows must hold.
    process.env.RATE_LIMIT_PASSWORD_RESET = '99';
    process.env.RATE_LIMIT_CONTACT = '99';
    vi.resetModules();

    // Act
    const { SECURITY_CONSTANTS } = await import('@/lib/security/constants');
    const limits = SECURITY_CONSTANTS.RATE_LIMIT.LIMITS;

    // Assert: windows are fixed regardless of cap overrides
    expect(limits.PASSWORD_RESET_INTERVAL).toBe(15 * 60 * 1000);
    expect(limits.CONTACT_INTERVAL).toBe(60 * 60 * 1000);
    expect(limits.UPLOAD_INTERVAL).toBe(15 * 60 * 1000);
    expect(limits.INVITE_INTERVAL).toBe(15 * 60 * 1000);
  });
});
