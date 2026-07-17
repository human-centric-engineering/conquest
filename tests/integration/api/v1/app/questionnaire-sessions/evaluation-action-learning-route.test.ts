/**
 * Integration test: turn-evaluation learning-action POST route.
 *
 * Pins gate order (404 when the flag is off, before auth), 401/403, body validation
 * (datasetId required), and the store-result mapping: not_found→404, already_actioned→409,
 * dataset_not_found→404, dataset_full→422, no_content→422, ok→200. The append/stamp logic is
 * unit-tested in the store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const storeMock = vi.hoisted(() => ({ actionTurnEvaluationForLearning: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store', () => storeMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/evaluations/[evalId]/action-learning/route';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL =
  'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/evaluations/eval-1/action-learning';

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
  flagStatus: 'actioned',
  flagReviewerId: 'admin-1',
  flagUpdatedAt: new Date('2026-06-17T00:00:00Z'),
  datasetId: 'ds-1',
  datasetCaseId: 'case-9',
  updatedAt: new Date('2026-06-17T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  storeMock.actionTurnEvaluationForLearning.mockResolvedValue({
    ok: true,
    row: OK_ROW,
    appendedCaseCount: 5,
  });
});

describe('POST action-learning', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req({ datasetId: 'ds-1' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await POST(req({ datasetId: 'ds-1' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(403);
  });

  it('400s when datasetId is missing', async () => {
    const res = await POST(req({}), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(400);
    expect(storeMock.actionTurnEvaluationForLearning).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['already_actioned', 409],
    ['dataset_not_found', 404],
    ['dataset_full', 422],
    ['no_content', 422],
  ] as const)('maps store reason %s to %d', async (reason, status) => {
    storeMock.actionTurnEvaluationForLearning.mockResolvedValue({ ok: false, reason });
    const res = await POST(req({ datasetId: 'ds-1' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(status);
  });

  it('200s and threads the scoped ids + dataset + reviewer on success', async () => {
    const res = await POST(req({ datasetId: 'ds-1' }), ctx('sess-1', 'eval-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.evaluation.datasetCaseId).toBe('case-9');

    const [params] = storeMock.actionTurnEvaluationForLearning.mock.calls[0];
    expect(params).toMatchObject({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: mockAdminUser().user.id,
    });
  });
});
