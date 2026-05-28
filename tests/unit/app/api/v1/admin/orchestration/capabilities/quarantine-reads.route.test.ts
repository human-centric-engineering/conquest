/**
 * Unit Test: Quarantine read routes (item #42)
 *
 * Covers the three GET endpoints that surface quarantine state to admin
 * pages — kept in one file because they share the same fixture shape
 * and the same auth + Prisma mocks.
 *
 * - GET /agents/:id/quarantined-capabilities
 *   - 404 on unknown agent
 *   - empty list when no bindings are quarantined
 *   - filters out auto-expired rows
 *   - maps to the QuarantinedCapabilityForAgent shape
 *
 * - GET /capabilities/:id/quarantine-attribution
 *   - 404 on unknown capability
 *   - { attribution: null } when capability is active
 *   - { attribution: null } when no audit row exists
 *   - actor falls back to email when name is null
 *
 * - GET /observability/active-quarantines
 *   - empty list when nothing is quarantined
 *   - filters out auto-expired rows
 *   - returns the ActiveQuarantineRow shape
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies (must precede route imports) ──────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockAgentFindUnique = vi.fn();
const mockBindingFindMany = vi.fn();
const mockCapFindUnique = vi.fn();
const mockCapFindMany = vi.fn();
const mockAuditFindFirst = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: (...a: unknown[]) => mockAgentFindUnique(...a) },
    aiAgentCapability: { findMany: (...a: unknown[]) => mockBindingFindMany(...a) },
    aiCapability: {
      findUnique: (...a: unknown[]) => mockCapFindUnique(...a),
      findMany: (...a: unknown[]) => mockCapFindMany(...a),
    },
    aiAdminAuditLog: { findFirst: (...a: unknown[]) => mockAuditFindFirst(...a) },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { GET as GET_AGENT_QUARANTINED } from '@/app/api/v1/admin/orchestration/agents/[id]/quarantined-capabilities/route';
import { GET as GET_ATTRIBUTION } from '@/app/api/v1/admin/orchestration/capabilities/[id]/quarantine-attribution/route';
import { GET as GET_ACTIVE_QUARANTINES } from '@/app/api/v1/admin/orchestration/observability/active-quarantines/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const CAP_ID = 'cmjbv4i3x00013wsloputgwul';

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/test`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

// ─── /agents/:id/quarantined-capabilities — auth ─────────────────────────────

describe('GET /agents/:id/quarantined-capabilities — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as USER (not admin)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    expect(res.status).toBe(403);
  });
});

// ─── /agents/:id/quarantined-capabilities ────────────────────────────────────

describe('GET /agents/:id/quarantined-capabilities', () => {
  it('returns 404 when the agent does not exist', async () => {
    mockAgentFindUnique.mockResolvedValue(null);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    expect(res.status).toBe(404);
  });

  it('returns an empty list when no bindings are quarantined', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  it('maps quarantined bindings to the response shape', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-1',
          slug: 'stripe_charge',
          name: 'Stripe Charge',
          quarantineState: 'quarantined-soft',
          quarantineReason: 'Vendor outage',
          quarantineUntil: null,
        },
      },
    ]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(body.data.items).toEqual([
      {
        capabilityId: 'cap-1',
        capabilitySlug: 'stripe_charge',
        capabilityName: 'Stripe Charge',
        mode: 'quarantined-soft',
        reason: 'Vendor outage',
        expiresAt: null,
      },
    ]);
  });

  it('returns 400 when the id param is not a valid CUID', async () => {
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams('not-a-cuid'));
    const body = await res.json();
    // Route validates id before touching the DB — agent should never be queried.
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mockAgentFindUnique).not.toHaveBeenCalled();
  });

  it('maps a quarantined-hard binding with null expiry to mode and expiresAt: null', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-hard',
          slug: 'risky_tool',
          name: 'Risky Tool',
          quarantineState: 'quarantined-hard',
          quarantineReason: 'Security audit',
          quarantineUntil: null, // indefinite hard quarantine
        },
      },
    ]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Route maps the raw DB column to the response shape — verify mode is
    // 'quarantined-hard' and expiresAt is null (not stringified).
    expect(body.data.items).toEqual([
      {
        capabilityId: 'cap-hard',
        capabilitySlug: 'risky_tool',
        capabilityName: 'Risky Tool',
        mode: 'quarantined-hard',
        reason: 'Security audit',
        expiresAt: null,
      },
    ]);
  });

  it('returns expiresAt as ISO string when quarantineUntil is a future Date', async () => {
    // Arrange: fixed far-future date avoids wall-clock dependency
    const futureDate = new Date('2099-01-01T00:00:00Z');
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-soft',
          slug: 'timed_tool',
          name: 'Timed Tool',
          quarantineState: 'quarantined-soft',
          quarantineReason: 'Vendor issue',
          quarantineUntil: futureDate,
        },
      },
    ]);

    // Act
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();

    // Assert: route converts the Date to ISO string and sets the correct mode
    expect(res.status).toBe(200);
    expect(body.data.items[0].expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(body.data.items[0].mode).toBe('quarantined-soft');
  });

  it('filters out bindings whose quarantineUntil has already passed', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-expired',
          slug: 'expired',
          name: 'Expired',
          quarantineState: 'quarantined-soft',
          quarantineReason: 'old',
          quarantineUntil: new Date(Date.now() - 60_000),
        },
      },
      {
        capability: {
          id: 'cap-active-q',
          slug: 'active-q',
          name: 'Still Quarantined',
          quarantineState: 'quarantined-hard',
          quarantineReason: 'now',
          quarantineUntil: null,
        },
      },
    ]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].capabilityId).toBe('cap-active-q');
  });
});

// ─── /capabilities/:id/quarantine-attribution ────────────────────────────────

describe('GET /capabilities/:id/quarantine-attribution', () => {
  it('returns 404 when the capability does not exist', async () => {
    mockCapFindUnique.mockResolvedValue(null);
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    expect(res.status).toBe(404);
  });

  it('returns { attribution: null } when capability is active (no audit query)', async () => {
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'active',
      quarantineUntil: null,
    });
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.attribution).toBeNull();
    expect(mockAuditFindFirst).not.toHaveBeenCalled();
  });

  it('returns { attribution: null } when the stored quarantine has auto-expired (no audit query)', async () => {
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'quarantined-soft',
      quarantineUntil: new Date(Date.now() - 60_000),
    });
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.attribution).toBeNull();
    // Effective state is active → must not hit the audit log either.
    expect(mockAuditFindFirst).not.toHaveBeenCalled();
  });

  it('returns { attribution: null } when no audit row exists for the quarantine', async () => {
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'quarantined-soft',
      quarantineUntil: null,
    });
    mockAuditFindFirst.mockResolvedValue(null);
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();
    expect(body.data.attribution).toBeNull();
  });

  it('returns 400 when id is not a valid CUID', async () => {
    // Arrange: invalid id — CUID validation fires before any DB query
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams('not-a-cuid'));
    const body = await res.json();
    // Assert: route rejects without hitting the DB
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/Invalid capability id/i);
    expect(mockCapFindUnique).not.toHaveBeenCalled();
  });

  it('uses actor name when the audit row has a user with name set', async () => {
    // Arrange
    const at = new Date('2026-05-01T12:00:00Z');
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'quarantined-soft',
      quarantineUntil: null,
    });
    mockAuditFindFirst.mockResolvedValue({
      createdAt: at,
      user: { name: 'Jane Doe', email: 'jane@example.com' },
    });

    // Act
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();

    // Assert: name takes precedence over email
    expect(body.data.attribution.actorName).toBe('Jane Doe');
    expect(body.data.attribution.at).toBe(at.toISOString());
  });

  it('falls back to email when the audit row has a user with null name', async () => {
    // Arrange
    const at = new Date('2026-05-01T12:00:00Z');
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'quarantined-soft',
      quarantineUntil: null,
    });
    mockAuditFindFirst.mockResolvedValue({
      createdAt: at,
      user: { name: null, email: 'jane@example.com' },
    });

    // Act
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();

    // Assert: email used as fallback when name is null
    expect(body.data.attribution.actorName).toBe('jane@example.com');
  });

  it("actorName is null when the audit row's user is null (deleted admin)", async () => {
    // Arrange: user row deleted — audit row preserved via onDelete: SetNull
    const at = new Date('2026-05-01T12:00:00Z');
    mockCapFindUnique.mockResolvedValue({
      id: CAP_ID,
      quarantineState: 'quarantined-soft',
      quarantineUntil: null,
    });
    mockAuditFindFirst.mockResolvedValue({ createdAt: at, user: null });

    // Act
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();

    // Assert: actorName is null when the user record no longer exists
    expect(body.data.attribution.actorName).toBeNull();
  });
});

// ─── /observability/active-quarantines — auth ────────────────────────────────

describe('GET /observability/active-quarantines — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin (USER role)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    expect(res.status).toBe(403);
  });
});

// ─── /observability/active-quarantines ───────────────────────────────────────

describe('GET /observability/active-quarantines', () => {
  it('returns an empty list when nothing is quarantined', async () => {
    mockCapFindMany.mockResolvedValue([]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  it('returns the ActiveQuarantineRow shape for each quarantined capability', async () => {
    const expiry = new Date('2099-01-01T00:00:00Z');
    mockCapFindMany.mockResolvedValue([
      {
        id: 'cap-1',
        slug: 'stripe_charge',
        name: 'Stripe Charge',
        quarantineState: 'quarantined-soft',
        quarantineReason: 'vendor 5xx',
        quarantineUntil: expiry,
      },
    ]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(body.data.items).toEqual([
      {
        id: 'cap-1',
        slug: 'stripe_charge',
        name: 'Stripe Charge',
        mode: 'quarantined-soft',
        reason: 'vendor 5xx',
        expiresAt: expiry.toISOString(),
      },
    ]);
  });

  it('returns expiresAt: null for indefinite hard quarantine (quarantineUntil is null)', async () => {
    mockCapFindMany.mockResolvedValue([
      {
        id: 'cap-2',
        slug: 'dangerous_op',
        name: 'Dangerous Op',
        quarantineState: 'quarantined-hard',
        quarantineReason: 'Permanent block',
        quarantineUntil: null, // indefinite — the null branch in the ternary
      },
    ]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    // Route maps the ternary r.quarantineUntil ? ... : null — verify null is
    // passed through (not stringified or omitted).
    expect(body.data.items).toEqual([
      {
        id: 'cap-2',
        slug: 'dangerous_op',
        name: 'Dangerous Op',
        mode: 'quarantined-hard',
        reason: 'Permanent block',
        expiresAt: null,
      },
    ]);
  });

  it('filters out rows whose quarantineUntil has already passed', async () => {
    mockCapFindMany.mockResolvedValue([
      {
        id: 'cap-expired',
        slug: 'expired',
        name: 'Expired',
        quarantineState: 'quarantined-soft',
        quarantineReason: null,
        quarantineUntil: new Date(Date.now() - 60_000),
      },
    ]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });
});
