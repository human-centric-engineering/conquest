/**
 * Integration test: persisted turn-evaluation search routes (list + detail).
 *
 * Pins gate order (404 when the flag is off, before auth), 401/403, the list passthrough to the
 * read model + paginated envelope, and the detail 404/200 mapping. The read models are unit-tested
 * separately (turn-evaluation-list.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const listMock = vi.hoisted(() => ({
  listTurnEvaluations: vi.fn(),
  getTurnEvaluationDetail: vi.fn(),
  // The real schema is re-exported so the list route's validateQueryParams runs against it.
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list', async () => {
  const actual = await vi.importActual<
    typeof import('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list')
  >('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list');
  return {
    listTurnEvaluationsQuerySchema: actual.listTurnEvaluationsQuerySchema,
    listTurnEvaluations: listMock.listTurnEvaluations,
    getTurnEvaluationDetail: listMock.getTurnEvaluationDetail,
  };
});

import { GET as LIST } from '@/app/api/v1/app/turn-evaluations/route';
import { GET as DETAIL } from '@/app/api/v1/app/turn-evaluations/[evalId]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function listReq(qs = ''): NextRequest {
  return {
    url: `http://localhost:3000/api/v1/app/turn-evaluations${qs}`,
    headers: new Headers(),
  } as unknown as NextRequest;
}
function detailReq(): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/turn-evaluations/eval-1',
    headers: new Headers(),
  } as unknown as NextRequest;
}
function detailCtx(evalId: string): { params: Promise<{ evalId: string }> } {
  return { params: Promise.resolve({ evalId }) };
}
/** The list route takes no route params; the wrapped handler still expects a context arg. */
const listCtx = { params: Promise.resolve({}) } as never;
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  listMock.listTurnEvaluations.mockResolvedValue({
    items: [
      {
        id: 'eval-1',
        sessionId: 'sess-1',
        turnOrdinal: 2,
        overallScore: 82,
        effectiveness: 'Good',
        flagStatus: 'flagged',
        questionnaireTitle: 'Housing Survey',
        createdAt: '2026-06-17T00:00:00.000Z',
      },
    ],
    total: 1,
  });
  listMock.getTurnEvaluationDetail.mockResolvedValue({ id: 'eval-1', verdict: {} });
});

describe('GET /turn-evaluations (list)', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null);
    const res = await LIST(listReq(), listCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await LIST(listReq(), listCtx)).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await LIST(listReq(), listCtx)).status).toBe(403);
  });

  it('400s on an invalid query (inverted score range)', async () => {
    const res = await LIST(listReq('?minScore=90&maxScore=10'), listCtx);
    expect(res.status).toBe(400);
    expect(listMock.listTurnEvaluations).not.toHaveBeenCalled();
  });

  it('200s with the paginated envelope and threads filters to the read model', async () => {
    const res = await LIST(listReq('?flagStatus=flagged&minScore=50&sortBy=overallScore'), listCtx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    // The route maps the read model's `items` → response `data` intact (not a single-key passthrough).
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      id: 'eval-1',
      sessionId: 'sess-1',
      overallScore: 82,
      effectiveness: 'Good',
      questionnaireTitle: 'Housing Survey',
    });
    expect(json.meta.total).toBe(1);

    const [query] = listMock.listTurnEvaluations.mock.calls[0];
    expect(query).toMatchObject({ flagStatus: 'flagged', minScore: 50, sortBy: 'overallScore' });
  });
});

describe('GET /turn-evaluations/:id (detail)', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null);
    const res = await DETAIL(detailReq(), detailCtx('eval-1'));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await DETAIL(detailReq(), detailCtx('eval-1'))).status).toBe(403);
  });

  it('404s when the evaluation does not exist', async () => {
    listMock.getTurnEvaluationDetail.mockResolvedValue(null);
    const res = await DETAIL(detailReq(), detailCtx('nope'));
    expect(res.status).toBe(404);
  });

  it('200s with the evaluation on the happy path', async () => {
    const res = await DETAIL(detailReq(), detailCtx('eval-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.evaluation.id).toBe('eval-1');
  });
});
