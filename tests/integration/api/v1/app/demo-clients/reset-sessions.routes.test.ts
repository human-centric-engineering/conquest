/**
 * DEMO-ONLY (F6.4) integration test: demo session-reset route.
 *
 * Exercises POST /api/v1/app/demo-clients/:id/reset-sessions with the DB seam mocked —
 * gate order (flag → auth → 404 → 409 anonymousMode → 400 confirmSlug), the precedence
 * (409 wins over a correct slug), the happy path + audit, the `?resetInvitations=true`
 * pass-through, and the empty-graph 200. The delete itself is unit-tested in _lib/reset.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  appDemoClient: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Mock the DB-touching seam; the route's guard orchestration is what's under test.
vi.mock('@/app/api/v1/app/demo-clients/_lib/reset', () => ({
  loadResetTargets: vi.fn(),
  performReset: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as resetPOST } from '@/app/api/v1/app/demo-clients/[id]/reset-sessions/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { loadResetTargets, performReset } from '@/app/api/v1/app/demo-clients/_lib/reset';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function jsonReq(
  body: unknown,
  url = 'http://localhost:3000/api/v1/app/demo-clients/dc-1/reset-sessions'
): NextRequest {
  return { url, headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

function ctx(id = 'dc-1'): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const CLIENT = { id: 'dc-1', name: 'Acme Bank', slug: 'acme-bank' };
const COUNTS = { sessions: 2, answerSlots: 5, turns: 4, events: 6, invitations: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appDemoClient.findUnique.mockResolvedValue(CLIENT);
  (loadResetTargets as unknown as Mock).mockResolvedValue({
    versionIds: ['v1', 'v2'],
    anyAnonymous: false,
  });
  (performReset as unknown as Mock).mockResolvedValue(COUNTS);
});

describe('POST /api/v1/app/demo-clients/:id/reset-sessions (F6.4)', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx())).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx())).status).toBe(403);
  });

  it('404s when the client is unknown', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    const res = await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx('missing'));
    expect(res.status).toBe(404);
    expect(performReset).not.toHaveBeenCalled();
  });

  it('400s on a malformed body (missing confirmSlug)', async () => {
    const res = await resetPOST(jsonReq({}), ctx());
    expect(res.status).toBe(400);
    expect(performReset).not.toHaveBeenCalled();
  });

  it('409s (anonymousMode) even when the slug is correct — the structural block wins', async () => {
    (loadResetTargets as unknown as Mock).mockResolvedValue({
      versionIds: ['v1'],
      anyAnonymous: true,
    });
    const res = await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ANONYMOUS_MODE_PROTECTED');
    expect(performReset).not.toHaveBeenCalled();
  });

  it('400s (CONFIRM_SLUG_MISMATCH) when the slug does not match the client', async () => {
    const res = await resetPOST(jsonReq({ confirmSlug: 'wrong-slug' }), ctx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFIRM_SLUG_MISMATCH');
    expect(performReset).not.toHaveBeenCalled();
  });

  it('400s on an invalid resetInvitations query value', async () => {
    const res = await resetPOST(
      jsonReq(
        { confirmSlug: 'acme-bank' },
        'http://localhost:3000/api/v1/app/demo-clients/dc-1/reset-sessions?resetInvitations=1'
      ),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(performReset).not.toHaveBeenCalled();
  });

  it('resets and audits on the happy path', async () => {
    const res = await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ id: 'dc-1', deletedCounts: COUNTS, resetInvitations: false });
    expect(performReset).toHaveBeenCalledWith(['v1', 'v2'], { resetInvitations: false });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'app_demo_client.reset_sessions',
        entityType: 'app_demo_client',
        entityId: 'dc-1',
        metadata: expect.objectContaining({ deletedCounts: COUNTS, resetInvitations: false }),
      })
    );
  });

  it('threads ?resetInvitations=true through to performReset', async () => {
    (performReset as unknown as Mock).mockResolvedValue({ ...COUNTS, invitations: 3 });
    const res = await resetPOST(
      jsonReq(
        { confirmSlug: 'acme-bank' },
        'http://localhost:3000/api/v1/app/demo-clients/dc-1/reset-sessions?resetInvitations=true'
      ),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(performReset).toHaveBeenCalledWith(['v1', 'v2'], { resetInvitations: true });
    const body = await res.json();
    expect(body.data.resetInvitations).toBe(true);
  });

  it('calls performReset([]) and still audits an empty-graph client (200, all-zero counts)', async () => {
    (loadResetTargets as unknown as Mock).mockResolvedValue({
      versionIds: [],
      anyAnonymous: false,
    });
    (performReset as unknown as Mock).mockResolvedValue({
      sessions: 0,
      answerSlots: 0,
      turns: 0,
      events: 0,
      invitations: 0,
    });
    const res = await resetPOST(jsonReq({ confirmSlug: 'acme-bank' }), ctx());
    expect(res.status).toBe(200);
    expect(performReset).toHaveBeenCalledWith([], { resetInvitations: false });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_demo_client.reset_sessions' })
    );
  });
});
