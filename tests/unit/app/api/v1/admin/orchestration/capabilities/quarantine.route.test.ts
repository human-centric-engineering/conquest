/**
 * Unit Test: Capability quarantine + unquarantine routes (item #42)
 *
 * Covers:
 * - Quarantine with valid mode + reason succeeds
 * - System capabilities CAN be quarantined (incident response overrides isSystem)
 * - Rejects past expiry
 * - Rejects missing reason (Zod validation)
 * - Dispatcher cache cleared
 * - Audit row written with the expected action string + metadata
 * - Hook event emitted
 * - Unquarantine clears all three fields
 * - Unquarantine is idempotent when already active (no audit, no hook)
 *
 * @see app/api/v1/admin/orchestration/capabilities/[id]/quarantine/route.ts
 * @see app/api/v1/admin/orchestration/capabilities/[id]/unquarantine/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies (must precede route imports) ──────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

const mockClearCache = vi.fn();
vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: () => mockClearCache() },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

const mockLogAdminAction = vi.fn();
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: (entry: unknown) => mockLogAdminAction(entry),
  computeChanges: vi.fn((before: unknown, after: unknown) => ({
    _stub: { from: before, to: after },
  })),
}));

const mockEmitHookEvent = vi.fn();
vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: (...args: unknown[]) => mockEmitHookEvent(...args),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { POST as QUARANTINE_POST } from '@/app/api/v1/admin/orchestration/capabilities/[id]/quarantine/route';
import { POST as UNQUARANTINE_POST } from '@/app/api/v1/admin/orchestration/capabilities/[id]/unquarantine/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CAP_ID = 'cmjbv4i3x00003wsloputgwul';

function makeCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: CAP_ID,
    name: 'Stripe Charge',
    slug: 'stripe_charge',
    description: 'Charge a customer card.',
    category: 'payments',
    functionDefinition: { name: 'stripe_charge' },
    executionType: 'api',
    executionHandler: 'https://api.stripe.com/v1/charges',
    isActive: true,
    isSystem: false,
    quarantineState: 'active',
    quarantineReason: null,
    quarantineUntil: null,
    ...overrides,
  };
}

function makeRequest(
  body: Record<string, unknown> | null,
  suffix: 'quarantine' | 'unquarantine'
): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/capabilities/${CAP_ID}/${suffix}`,
    json: () => Promise.resolve(body ?? {}),
  } as unknown as NextRequest;
}

function makeParams() {
  return { params: Promise.resolve({ id: CAP_ID }) };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /capabilities/[id]/quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('quarantines with valid soft mode + reason', async () => {
    const cap = makeCapability();
    mockFindUnique.mockResolvedValue(cap);
    mockUpdate.mockResolvedValue({
      ...cap,
      quarantineState: 'quarantined-soft',
      quarantineReason: 'Stripe 5xx since 14:32 UTC',
    });

    const response = await QUARANTINE_POST(
      makeRequest({ mode: 'quarantined-soft', reason: 'Stripe 5xx since 14:32 UTC' }, 'quarantine'),
      makeParams()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.quarantineState).toBe('quarantined-soft');

    // Cache cleared so the dispatcher re-reads on the next call.
    expect(mockClearCache).toHaveBeenCalledTimes(1);

    // Audit row written under the dedicated action string.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction.mock.calls[0][0]).toMatchObject({
      action: 'capability.quarantine',
      entityType: 'capability',
      entityId: CAP_ID,
      metadata: expect.objectContaining({
        mode: 'quarantined-soft',
        reason: 'Stripe 5xx since 14:32 UTC',
      }),
    });

    // Hook event emitted.
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      'capability.quarantined',
      expect.objectContaining({
        capabilityId: CAP_ID,
        mode: 'quarantined-soft',
        reason: 'Stripe 5xx since 14:32 UTC',
      })
    );
  });

  it('quarantines system capabilities (no isSystem guard)', async () => {
    const cap = makeCapability({ isSystem: true });
    mockFindUnique.mockResolvedValue(cap);
    mockUpdate.mockResolvedValue({ ...cap, quarantineState: 'quarantined-hard' });

    const response = await QUARANTINE_POST(
      makeRequest({ mode: 'quarantined-hard', reason: 'sending wrong data' }, 'quarantine'),
      makeParams()
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects a past expiry timestamp', async () => {
    mockFindUnique.mockResolvedValue(makeCapability());

    const past = new Date(Date.now() - 60_000).toISOString();
    const response = await QUARANTINE_POST(
      makeRequest({ mode: 'quarantined-soft', reason: 'x', expiresAt: past }, 'quarantine'),
      makeParams()
    );

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('rejects missing reason via Zod validation', async () => {
    mockFindUnique.mockResolvedValue(makeCapability());

    const response = await QUARANTINE_POST(
      makeRequest({ mode: 'quarantined-soft', reason: '' }, 'quarantine'),
      makeParams()
    );

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown capability', async () => {
    mockFindUnique.mockResolvedValue(null);

    const response = await QUARANTINE_POST(
      makeRequest({ mode: 'quarantined-soft', reason: 'x' }, 'quarantine'),
      makeParams()
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /capabilities/[id]/unquarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('clears all three quarantine fields', async () => {
    const cap = makeCapability({
      quarantineState: 'quarantined-soft',
      quarantineReason: 'vendor outage',
      quarantineUntil: new Date('2099-01-01'),
    });
    mockFindUnique.mockResolvedValue(cap);
    mockUpdate.mockResolvedValue({
      ...cap,
      quarantineState: 'active',
      quarantineReason: null,
      quarantineUntil: null,
    });

    const response = await UNQUARANTINE_POST(makeRequest(null, 'unquarantine'), makeParams());

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: CAP_ID },
      data: {
        quarantineState: 'active',
        quarantineReason: null,
        quarantineUntil: null,
      },
    });
    expect(mockClearCache).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction.mock.calls[0][0]).toMatchObject({
      action: 'capability.unquarantine',
      metadata: { previousMode: 'quarantined-soft' },
    });
    expect(mockEmitHookEvent).toHaveBeenCalledWith(
      'capability.unquarantined',
      expect.objectContaining({ capabilityId: CAP_ID, previousMode: 'quarantined-soft' })
    );
  });

  it('is idempotent when already active — no update, no audit, no hook', async () => {
    const cap = makeCapability({ quarantineState: 'active' });
    mockFindUnique.mockResolvedValue(cap);

    const response = await UNQUARANTINE_POST(makeRequest(null, 'unquarantine'), makeParams());

    expect(response.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('is idempotent on effective state — auto-expired quarantine does not write or fire', async () => {
    // Stored as quarantined-soft but `quarantineUntil` has passed.
    // The dispatcher treats this as active; lifting it must not
    // emit a `capability.unquarantined` event per the documented
    // invariant in hooks/types.ts.
    const cap = makeCapability({
      quarantineState: 'quarantined-soft',
      quarantineReason: 'expired window',
      quarantineUntil: new Date(Date.now() - 60_000),
    });
    mockFindUnique.mockResolvedValue(cap);

    const response = await UNQUARANTINE_POST(makeRequest(null, 'unquarantine'), makeParams());

    expect(response.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown capability', async () => {
    mockFindUnique.mockResolvedValue(null);

    const response = await UNQUARANTINE_POST(makeRequest(null, 'unquarantine'), makeParams());

    expect(response.status).toBe(404);
  });
});
