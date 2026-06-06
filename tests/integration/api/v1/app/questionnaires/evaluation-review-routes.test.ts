/**
 * Integration test: design-evaluation finding review + apply routes (F5.3).
 *
 * PATCH …/findings/:findingId  — accept / decline / edit (real DB seam mocked).
 * POST  …/findings/:findingId/apply — gating, scoping, response shaping (the apply ENGINE is
 *   mocked here; its internals — fork lineage, op execution — are covered by the apply-engine
 *   and staleness unit tests).
 *
 * Covers: sub-flag-off 404, auth, finding-scope 404, the `applied` terminal 409, each review
 * action's write, the apply rate-limit 429, an `unapplicable` 409 with its reason, and a
 * successful apply's fork meta.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireEvaluationFinding: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  evaluationApplyLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

const applyMock = vi.hoisted(() => ({ applyFinding: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-apply', () => applyMock);

// The apply route loads the live structure via this seam; keep it trivial (the real
// `loadScopedVersion` runs against the prisma mock — its row is set in beforeEach).
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-structure', () => ({
  buildEvaluationStructure: vi.fn(),
}));

import { PATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/findings/[findingId]/route';
import { POST as APPLY } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/findings/[findingId]/apply/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG } from '@/lib/app/questionnaire/constants';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { applyFinding } from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const PARAMS = { id: 'qn-1', vid: 'v1', runId: 'run-1', findingId: 'find-1' };
const URL =
  'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/evaluations/run-1/findings/find-1';

function req(body?: unknown, url = URL): NextRequest {
  return {
    url,
    headers: new Headers(),
    json: () => Promise.resolve(body ?? {}),
  } as unknown as NextRequest;
}
function ctx() {
  return { params: Promise.resolve(PARAMS) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}
/** All feature flags on by default (master + sub). */
function allFlagsOn() {
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
}
function subFlagOff() {
  vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
    Promise.resolve(name !== APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG)
  );
}

/** A scoped finding row as `loadScopedFinding` returns it (finding + nested run). */
function findingRow(status = 'pending', proposedEdit: unknown = { op: 'delete_question' }) {
  return {
    id: 'find-1',
    dimension: 'duplicates',
    ordinal: 0,
    targetKey: 'q_dupe',
    severity: 'minor',
    proposedChange: 'Remove the duplicate.',
    rationale: 'Same as q_role.',
    sourceQuote: null,
    proposedEdit,
    editedOverride: null,
    status,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    run: { versionId: 'v1', questionnaireId: 'qn-1', structureSnapshot: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  allFlagsOn();
  setAuth(mockAdminUser());
  (buildEvaluationStructure as unknown as Mock).mockResolvedValue(null); // skip derivation
  // Real `loadScopedVersion` resolves this row (apply route).
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
});

describe('PATCH finding review', () => {
  it('404s when the design-evaluation sub-flag is off (after auth)', async () => {
    subFlagOff();
    const res = await PATCH(req({ action: 'accept' }), ctx());
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PATCH(req({ action: 'accept' }), ctx());
    expect([401, 403]).toContain(res.status);
  });

  it('404s when the finding does not resolve in (version, run)', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(null);
    const res = await PATCH(req({ action: 'accept' }), ctx());
    expect(res.status).toBe(404);
  });

  it('accepts a finding → status accepted', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst
      .mockResolvedValueOnce(findingRow('pending'))
      .mockResolvedValueOnce(findingRow('accepted'));
    prismaMock.appQuestionnaireEvaluationFinding.update.mockResolvedValue({});

    const res = await PATCH(req({ action: 'accept' }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('accepted');
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'accepted' }) })
    );
  });

  it('stores an edited override', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst
      .mockResolvedValueOnce(findingRow('pending'))
      .mockResolvedValueOnce(findingRow('pending'));
    prismaMock.appQuestionnaireEvaluationFinding.update.mockResolvedValue({});

    const res = await PATCH(
      req({ action: 'edit', editedOverride: { op: 'replace_prompt', prompt: 'Clearer?' } }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          editedOverride: { op: 'replace_prompt', prompt: 'Clearer?' },
        }),
      })
    );
  });

  it('rejects an edit whose override op is malformed (400)', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('pending'));
    const res = await PATCH(req({ action: 'edit', editedOverride: { op: 'nope' } }), ctx());
    expect(res.status).toBe(400);
  });

  it('409s when the finding is already applied (terminal)', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('applied'));
    const res = await PATCH(req({ action: 'decline' }), ctx());
    expect(res.status).toBe(409);
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).not.toHaveBeenCalled();
  });

  it('derives applicable against the live structure in the response', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst
      .mockResolvedValueOnce(findingRow('pending'))
      .mockResolvedValueOnce(findingRow('accepted'));
    prismaMock.appQuestionnaireEvaluationFinding.update.mockResolvedValue({});
    // A live structure is available, so buildScopedFindingView runs the deriver (not skipped).
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [{ title: 'S', questions: [] }],
    });

    const res = await PATCH(req({ action: 'accept' }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    // proposedEdit is delete_question → applicable 'apply'.
    expect(body.data.applicable).toBe('apply');
  });
});

describe('POST finding apply', () => {
  it('404s when the sub-flag is off', async () => {
    subFlagOff();
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyFinding).not.toHaveBeenCalled();
  });

  it('429s when the apply sub-cap is exceeded', async () => {
    rateLimitMock.evaluationApplyLimiter.check.mockReturnValueOnce({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000,
    });
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(429);
  });

  it('returns 409 with the reason when the engine reports unapplicable', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('pending'));
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });
    (applyFinding as unknown as Mock).mockResolvedValue({
      status: 'unapplicable',
      reason: 'stale',
    });

    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details.reason).toBe('stale');
  });

  it('applies and surfaces the fork meta on success', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst
      .mockResolvedValueOnce(findingRow('pending')) // initial load
      .mockResolvedValueOnce(findingRow('applied')); // re-load for response
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });
    (applyFinding as unknown as Mock).mockResolvedValue({
      status: 'applied',
      appliedToVersionId: 'v2',
      forked: true,
      versionNumber: 2,
    });

    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
    expect(body.data.finding.status).toBe('applied');
  });

  it('409s when the finding is already applied', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('applied'));
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(409);
    expect(applyFinding).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyFinding).not.toHaveBeenCalled();
  });

  it('404s when the finding does not resolve', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(null);
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyFinding).not.toHaveBeenCalled();
  });

  it('404s when the live structure cannot be built', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('pending'));
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue(null);
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(404);
    expect(applyFinding).not.toHaveBeenCalled();
  });

  it('includes the engine detail in the 409 body when present', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(findingRow('pending'));
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });
    (applyFinding as unknown as Mock).mockResolvedValue({
      status: 'unapplicable',
      reason: 'op_invalid',
      detail: 'choices required',
    });
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.details).toMatchObject({ reason: 'op_invalid', detail: 'choices required' });
  });

  it('returns a null finding when the re-load after apply finds nothing', async () => {
    prismaMock.appQuestionnaireEvaluationFinding.findFirst
      .mockResolvedValueOnce(findingRow('pending')) // initial load
      .mockResolvedValueOnce(null); // re-load returns nothing
    (buildEvaluationStructure as unknown as Mock).mockResolvedValue({
      goal: null,
      audience: null,
      sections: [],
    });
    (applyFinding as unknown as Mock).mockResolvedValue({
      status: 'applied',
      appliedToVersionId: 'v1',
      forked: false,
      versionNumber: 1,
    });
    const res = await APPLY(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.finding).toBeNull();
  });
});
