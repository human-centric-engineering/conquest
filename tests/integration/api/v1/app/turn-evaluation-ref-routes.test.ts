/**
 * Integration test: ref-lookup (GET by-ref) + saved-turn evaluation (POST evaluate-saved) routes.
 *
 * Pins gate order (404 when the flag is off, before auth), 401/403, ordinal validation, the
 * rate-limit 429, and the store-result → HTTP mapping. The read model + orchestration helper are
 * unit-tested separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const listMock = vi.hoisted(() => ({ lookupSessionByRef: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list', () => listMock);

const savedMock = vi.hoisted(() => ({ runSavedTurnEvaluation: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/evaluate-saved-turn', () => savedMock);

const rateLimitMock = vi.hoisted(() => ({
  turnEvaluationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateLimitMock);

import { GET as BY_REF } from '@/app/api/v1/app/turn-evaluations/by-ref/[ref]/route';
import { POST as EVAL_SAVED } from '@/app/api/v1/app/questionnaire-sessions/[id]/turns/[ordinal]/evaluate-saved/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(url: string): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}
function setAuth(s: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}
function refCtx(ref: string) {
  return { params: Promise.resolve({ ref }) };
}
function savedCtx(id: string, ordinal: string) {
  return { params: Promise.resolve({ id, ordinal }) };
}

const REF_URL = 'http://localhost:3000/api/v1/app/turn-evaluations/by-ref/7F3K-9M2P';
const SAVED_URL =
  'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/turns/2/evaluate-saved';

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  listMock.lookupSessionByRef.mockResolvedValue({ session: { id: 'sess-1' }, turns: [] });
  savedMock.runSavedTurnEvaluation.mockResolvedValue({
    ok: true,
    verdict: { overallScore: 80 },
    costUsd: 0.004,
    model: 'claude-x',
    evaluationId: 'eval-1',
  });
  rateLimitMock.turnEvaluationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
});

describe('GET by-ref', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null);
    const res = await BY_REF(req(REF_URL), refCtx('7F3K-9M2P'));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await BY_REF(req(REF_URL), refCtx('x'))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await BY_REF(req(REF_URL), refCtx('x'))).status).toBe(403);
  });

  it('404s when no session matches the ref', async () => {
    listMock.lookupSessionByRef.mockResolvedValue(null);
    expect((await BY_REF(req(REF_URL), refCtx('nope'))).status).toBe(404);
  });

  it('200s with the lookup result', async () => {
    const res = await BY_REF(req(REF_URL), refCtx('7F3K-9M2P'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.session.id).toBe('sess-1');
    expect(listMock.lookupSessionByRef).toHaveBeenCalledWith('7F3K-9M2P');
  });
});

describe('POST evaluate-saved', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null);
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'))).status).toBe(403);
  });

  it('400s on a non-positive ordinal', async () => {
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '0'));
    expect(res.status).toBe(400);
    expect(savedMock.runSavedTurnEvaluation).not.toHaveBeenCalled();
  });

  it('429s when the per-admin sub-cap is exceeded', async () => {
    rateLimitMock.turnEvaluationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 9_999_999_999,
    });
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'));
    expect(res.status).toBe(429);
    expect(savedMock.runSavedTurnEvaluation).not.toHaveBeenCalled();
  });

  it.each([
    ['turn_not_found', 404, 'Turn not found'],
    ['session_not_found', 404, 'Session not found'],
    ['no_traces', 422, 'This turn has no saved inspector traces to evaluate'],
    ['not_configured', 404, 'Turn evaluation is not configured'],
    ['failed', 502, 'Turn evaluation failed'],
  ] as const)('maps result %s to %d with its own message', async (reason, status, message) => {
    savedMock.runSavedTurnEvaluation.mockResolvedValue({ ok: false, reason });
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'));
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.success).toBe(false);
    // session_not_found and turn_not_found must not collapse to the same message.
    expect(json.error.message).toBe(message);
  });

  it('200s with the verdict + evaluationId, threading sessionId/ordinal/admin', async () => {
    const res = await EVAL_SAVED(req(SAVED_URL), savedCtx('sess-1', '2'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.verdict.overallScore).toBe(80);
    expect(json.data.evaluationId).toBe('eval-1');

    const [params] = savedMock.runSavedTurnEvaluation.mock.calls[0];
    expect(params).toMatchObject({
      sessionId: 'sess-1',
      ordinal: 2,
      adminId: mockAdminUser().user.id,
    });
  });
});
