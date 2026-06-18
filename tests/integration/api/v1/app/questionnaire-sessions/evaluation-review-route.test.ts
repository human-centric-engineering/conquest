/**
 * Integration test: turn-evaluation review PATCH route.
 *
 * Pins gate order (404 when the flag is off, before auth), 401/403, body validation
 * (≥1 field; `actioned` rejected by the enum), and the store-result mapping: not_found→404,
 * locked→409, ok→200. The store itself (transition/stamp logic) is unit-tested separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const storeMock = vi.hoisted(() => ({
  updateTurnEvaluationReview: vi.fn(),
  TURN_EVAL_REVIEW_STATUSES: ['none', 'flagged', 'reviewed', 'dismissed'] as const,
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store', () => storeMock);

import { PATCH } from '@/app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/evaluations/eval-1';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx(id: string, evalId: string): { params: Promise<{ id: string; evalId: string }> } {
  return { params: Promise.resolve({ id, evalId }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const OK_ROW = {
  id: 'eval-1',
  comment: 'note',
  commentByUserId: 'admin-1',
  commentAt: new Date('2026-06-17T00:00:00Z'),
  flagStatus: 'flagged',
  flagReviewerId: 'admin-1',
  flagUpdatedAt: new Date('2026-06-17T00:00:00Z'),
  updatedAt: new Date('2026-06-17T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  storeMock.updateTurnEvaluationReview.mockResolvedValue({ ok: true, row: OK_ROW });
});

describe('PATCH evaluation review', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null);
    const res = await PATCH(req({ flagStatus: 'flagged' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PATCH(req({ flagStatus: 'flagged' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await PATCH(req({ flagStatus: 'flagged' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(403);
  });

  it('400s on an empty body (no comment, no flagStatus)', async () => {
    const res = await PATCH(req({}), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(400);
    expect(storeMock.updateTurnEvaluationReview).not.toHaveBeenCalled();
  });

  it('400s when flagStatus is the action-owned "actioned" value', async () => {
    const res = await PATCH(req({ flagStatus: 'actioned' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(400);
    expect(storeMock.updateTurnEvaluationReview).not.toHaveBeenCalled();
  });

  it('404s when the store reports not_found', async () => {
    storeMock.updateTurnEvaluationReview.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await PATCH(req({ comment: 'x' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(404);
  });

  it('409s when the row is actioned (locked)', async () => {
    storeMock.updateTurnEvaluationReview.mockResolvedValue({ ok: false, reason: 'locked' });
    const res = await PATCH(req({ flagStatus: 'flagged' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('evaluation_actioned');
  });

  it('200s and threads the scoped ids + reviewer on the happy path', async () => {
    const res = await PATCH(
      req({ comment: 'useful', flagStatus: 'reviewed' }),
      ctx('sess-1', 'eval-1')
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.evaluation.flagStatus).toBe('flagged');

    const [params] = storeMock.updateTurnEvaluationReview.mock.calls[0];
    expect(params).toMatchObject({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: mockAdminUser().user.id,
      comment: 'useful',
      flagStatus: 'reviewed',
    });
  });
});
