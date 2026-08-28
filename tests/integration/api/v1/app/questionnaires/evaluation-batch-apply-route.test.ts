/**
 * Integration test: the design-evaluation batch apply route (F5.4).
 *
 * POST …/evaluations/:runId/apply — the ONLY way a suggestion reaches the questionnaire from the
 * review surface. The engine underneath is mocked here (its ordering, live re-read, AI leg and
 * per-finding report are covered by `evaluation-batch-apply.test.ts`); what this file pins is the
 * route's own contract, and one clause of it is unusual enough to be worth a test on its own:
 *
 * **It returns 200 whenever the run resolves, even when nothing applied.** "Every accepted change
 * was already stale" is an answer the reviewer needs the per-finding detail of, and an error
 * envelope would throw that detail away. A future refactor that "helpfully" 409s an empty apply
 * would delete the only place a dropped change is ever named.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireEvaluationRun: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const rateLimitMock = vi.hoisted(() => ({
  evaluationApplyLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

const batchMock = vi.hoisted(() => ({
  applyAcceptedFindings: vi.fn(),
  loadAcceptedFindings: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-batch-apply', () => batchMock);

const runRoutesMock = vi.hoisted(() => ({
  getEvaluationRunDetail: vi.fn(),
  parseStructureSnapshot: vi.fn(() => null),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes', () => runRoutesMock);

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/apply/route';

import { auth } from '@/lib/auth/config';
import {
  applyAcceptedFindings,
  loadAcceptedFindings,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-batch-apply';
import { getEvaluationRunDetail } from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const PARAMS = { id: 'qn-1', vid: 'v1', runId: 'run-1' };
const URL =
  'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/evaluations/run-1/apply';

function req(): NextRequest {
  return { url: URL, headers: new Headers() } as unknown as NextRequest;
}
function ctx() {
  return { params: Promise.resolve(PARAMS) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

/** A batch result with nothing applied and nothing skipped — overridden per test. */
function result(over: Record<string, unknown> = {}) {
  return {
    versionId: 'v1',
    versionNumber: 1,
    forked: false,
    applied: [],
    skipped: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  rateLimitMock.evaluationApplyLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue({
    id: 'run-1',
    structureSnapshot: null,
  });
  (loadAcceptedFindings as unknown as Mock).mockResolvedValue([]);
  (applyAcceptedFindings as unknown as Mock).mockResolvedValue(result());
  (getEvaluationRunDetail as unknown as Mock).mockResolvedValue({ findings: [] });
});

describe('POST evaluations/:runId/apply', () => {
  it('401s when unauthenticated, and writes nothing', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req(), ctx());
    expect([401, 403]).toContain(res.status);
    expect(applyAcceptedFindings).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyAcceptedFindings).not.toHaveBeenCalled();
  });

  it('404s when the run does not belong to this version', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyAcceptedFindings).not.toHaveBeenCalled();
  });

  it('429s on the apply sub-cap without touching the questionnaire', async () => {
    // One call may fork a launched version and then write many edits — and, since F5.4's AI leg,
    // may also make a model call per steered finding. The sub-cap is the thing standing in front
    // of both, so it has to run before any of that work starts.
    rateLimitMock.evaluationApplyLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000,
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(429);
    expect(applyAcceptedFindings).not.toHaveBeenCalled();
  });

  it('returns 200 with the per-finding reasons when nothing could be applied', async () => {
    // The clause this file exists for. An error envelope here would throw away the only report
    // the reviewer ever sees of a change that did not land.
    (applyAcceptedFindings as unknown as Mock).mockResolvedValue(
      result({
        skipped: [
          { findingId: 'f1', targetKey: 'q_role', reason: 'stale' },
          {
            findingId: 'f2',
            targetKey: 'q_team',
            reason: 'needs_ai',
            detail: 'The AI could not rewrite this change.',
          },
        ],
      })
    );

    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.applied).toEqual([]);
    expect(body.data.skipped).toHaveLength(2);
    expect(body.data.skipped[1]).toMatchObject({ reason: 'needs_ai' });
  });

  it('carries the steer report through to the client', async () => {
    // `unhonoured` is the load-bearing half: a steer that only partly landed has to reach the
    // reviewer, or "applied" reads as "all of it applied".
    (applyAcceptedFindings as unknown as Mock).mockResolvedValue(
      result({
        applied: [
          {
            findingId: 'f1',
            targetKey: 'q_role',
            op: 'replace_prompt',
            steer: { note: 'Shortened it.', unhonoured: 'A 1–5 scale is not a wording change.' },
          },
        ],
      })
    );

    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(body.data.applied[0].steer).toEqual({
      note: 'Shortened it.',
      unhonoured: 'A 1–5 scale is not a wording change.',
    });
  });

  it('reports the fork in both the body and the meta, and re-derives the whole run', async () => {
    // The queue re-renders from this one response: applied findings are terminal now, and the ones
    // skipped as stale need their fresh flag to say why.
    (applyAcceptedFindings as unknown as Mock).mockResolvedValue(
      result({
        versionId: 'v2',
        versionNumber: 2,
        forked: true,
        applied: [{ findingId: 'f1', targetKey: 'q_role', op: 'replace_prompt' }],
      })
    );
    (getEvaluationRunDetail as unknown as Mock).mockResolvedValue({
      findings: [{ id: 'f1', status: 'applied' }],
    });

    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(body.data).toMatchObject({ versionId: 'v2', versionNumber: 2, forked: true });
    expect(body.meta).toMatchObject({ versionId: 'v2', versionNumber: 2, forked: true });
    expect(body.data.findings).toEqual([{ id: 'f1', status: 'applied' }]);
  });

  it('still answers when the run re-read comes back empty', async () => {
    // The writes already happened; losing the re-derivation must not turn a successful batch into
    // an error the reviewer cannot act on.
    (applyAcceptedFindings as unknown as Mock).mockResolvedValue(
      result({ applied: [{ findingId: 'f1', targetKey: 'q_role', op: 'replace_prompt' }] })
    );
    (getEvaluationRunDetail as unknown as Mock).mockResolvedValue(null);

    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.findings).toEqual([]);
    expect(body.data.applied).toHaveLength(1);
  });

  it('passes the run’s accepted findings and the admin’s attribution to the engine', async () => {
    (loadAcceptedFindings as unknown as Mock).mockResolvedValue([{ id: 'f1' }]);
    await POST(req(), ctx());

    expect(loadAcceptedFindings).toHaveBeenCalledWith('run-1');
    expect(applyAcceptedFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: [{ id: 'f1' }],
        runId: 'run-1',
        questionnaireId: 'qn-1',
        audit: expect.objectContaining({ userId: mockAdminUser().user.id }),
      })
    );
  });
});
