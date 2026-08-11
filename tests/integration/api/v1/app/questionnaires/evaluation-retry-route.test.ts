/**
 * Integration test: single-judge retry on an existing evaluation run.
 *
 * The panel is fail-soft per judge, so a run can persist with one judge missing — which makes its
 * severity totals an undercount. This route fills that hole *in place*. The behaviours worth
 * pinning are the ones a "just re-run the panel" implementation would get wrong:
 *
 *   - only the named judge is dispatched (not the other six);
 *   - it reads the run's structure SNAPSHOT, not the live structure, so the run stays a verdict
 *     on one structure;
 *   - the merge replaces that dimension's findings and re-derives the run's tallies/status —
 *     it never appends a second run or double-writes findings;
 *   - a judge that already returned a verdict is refused (409), because its findings may already
 *     carry review decisions;
 *   - a retry that fails again is merged with the FRESH diagnostic and leaves the run partial.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  aiAgent: { findMany: vi.fn() },
  appQuestionnaireEvaluationRun: { findFirst: vi.fn(), update: vi.fn() },
  appQuestionnaireEvaluationFinding: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    aggregate: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatchMock = vi.hoisted(() => ({ capabilityDispatcher: { dispatch: vi.fn() } }));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  designEvaluationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/retry/route';

import { auth } from '@/lib/auth/config';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL_ =
  'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/evaluations/run-1/retry';
const PARAMS = { id: 'qn-1', vid: 'v1', runId: 'run-1' };

function req(body: unknown): NextRequest {
  return {
    url: URL_,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

/** The structure the judges actually read, stored on the run. */
function snapshot() {
  return {
    goal: 'Understand onboarding friction.',
    audience: { role: 'Engineer' },
    sections: [
      {
        title: 'Background',
        questions: [
          { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
        ],
      },
    ],
  };
}

/** A newer live structure — proves the retry reads the snapshot, not this. */
function liveVersionGraphRow() {
  return {
    goal: 'A GOAL EDITED SINCE THE RUN.',
    audience: { role: 'Engineer' },
    sections: [
      {
        title: 'Background',
        description: null,
        questions: [
          {
            key: 'q_role',
            prompt: 'Rewritten prompt.',
            type: 'free_text',
            required: true,
            guidelines: null,
          },
        ],
      },
    ],
  };
}

/** The run row `loadRunForJudgeRetry` reads: clarity ran, ordering failed. */
function runRow(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    versionId: 'v1',
    questionnaireId: 'qn-1',
    dimensionSummary: [
      { dimension: 'clarity', score: 0.8, findingCount: 1, diagnostic: null },
      { dimension: 'ordering', score: null, findingCount: 0, diagnostic: 'dispatch_error' },
    ],
    structureSnapshot: snapshot(),
    ...over,
  };
}

/** The detail row the post-merge re-read returns (shape only — the merge is asserted on `update`). */
function detailRow() {
  const now = new Date('2026-06-05T12:00:00Z');
  return {
    id: 'run-1',
    versionId: 'v1',
    questionnaireId: 'qn-1',
    status: 'completed',
    triggeredByUserId: 'admin-1',
    dimensionsRequested: 2,
    dimensionsRun: 2,
    dimensionsFailed: 0,
    totalFindings: 2,
    dimensionSummary: [
      { dimension: 'clarity', score: 0.8, findingCount: 1, diagnostic: null },
      { dimension: 'ordering', score: 0.7, findingCount: 1, diagnostic: null },
    ],
    structureSnapshot: snapshot(),
    error: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    findings: [],
  };
}

function dispatchSuccess(dimension: string) {
  return {
    success: true,
    data: {
      verdict: {
        dimension,
        score: 0.7,
        findings: [
          {
            targetKey: 'q_role',
            severity: 'major',
            proposedChange: 'Move this later.',
            rationale: 'Context first.',
          },
        ],
      },
    },
  };
}

const ORDERING_SLUG = EVALUATION_DIMENSION_SPECS.ordering.slug;

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(liveVersionGraphRow());
  prismaMock.aiAgent.findMany.mockResolvedValue([
    { slug: ORDERING_SLUG, id: 'agent-ordering', provider: '', model: '', fallbackProviders: [] },
  ]);
  dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) =>
    Promise.resolve(dispatchSuccess((args as { dimension: string }).dimension))
  );
  rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  prismaMock.$transaction.mockImplementation((cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock)
  );
  // First read: the retry loader. Second read: the post-merge detail re-read.
  prismaMock.appQuestionnaireEvaluationRun.findFirst
    .mockResolvedValueOnce(runRow())
    .mockResolvedValue(detailRow());
  prismaMock.appQuestionnaireEvaluationFinding.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.appQuestionnaireEvaluationFinding.createMany.mockResolvedValue({ count: 1 });
  prismaMock.appQuestionnaireEvaluationFinding.aggregate.mockResolvedValue({
    _max: { ordinal: 4 },
  });
  prismaMock.appQuestionnaireEvaluationFinding.count.mockResolvedValue(2);
});

describe('POST retry — gates', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(403);
  });

  it('400s on an unknown dimension', async () => {
    expect((await POST(req({ dimension: 'vibes' }), ctx(PARAMS))).status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('429s when the paid sub-cap is exhausted, before any dispatch', async () => {
    rateLimitMock.designEvaluationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('404s when the run does not resolve under this version', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst.mockReset().mockResolvedValue(null);
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('404s when the run belongs to a different questionnaire', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst
      .mockReset()
      .mockResolvedValue(runRow({ questionnaireId: 'qn-other' }));
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(404);
  });

  it('404s when the judge was never part of this run', async () => {
    // `coverage` is a valid dimension but absent from this run's panel.
    expect((await POST(req({ dimension: 'coverage' }), ctx(PARAMS))).status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('409s when that judge already returned a verdict', async () => {
    const res = await POST(req({ dimension: 'clarity' }), ctx(PARAMS));
    expect(res.status).toBe(409);
    // Nothing is dispatched and nothing is deleted — its findings may carry review decisions.
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireEvaluationFinding.deleteMany).not.toHaveBeenCalled();
  });

  it('404s when that judge has no seeded agent', async () => {
    prismaMock.aiAgent.findMany.mockResolvedValue([]);
    expect((await POST(req({ dimension: 'ordering' }), ctx(PARAMS))).status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('POST retry — dispatch', () => {
  it('dispatches only the named judge, against the run snapshot rather than the live structure', async () => {
    const res = await POST(req({ dimension: 'ordering' }), ctx(PARAMS));
    expect(res.status).toBe(200);

    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0] as [
      string,
      { dimension: string; structure: { goal: string } },
    ];
    expect(args.dimension).toBe('ordering');
    expect(args.structure.goal).toBe('Understand onboarding friction.');

    // Only that judge's agent was loaded.
    expect(prismaMock.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: ORDERING_SLUG, kind: 'judge' } })
    );
  });

  it('falls back to the live structure on a pre-snapshot run', async () => {
    prismaMock.appQuestionnaireEvaluationRun.findFirst
      .mockReset()
      .mockResolvedValueOnce(runRow({ structureSnapshot: null }))
      .mockResolvedValue(detailRow());

    await POST(req({ dimension: 'ordering' }), ctx(PARAMS));

    const [, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0] as [
      string,
      { structure: { goal: string } },
    ];
    expect(args.structure.goal).toBe('A GOAL EDITED SINCE THE RUN.');
  });
});

describe('POST retry — merge', () => {
  it('replaces that judge’s findings and re-derives the run to completed', async () => {
    const res = await POST(req({ dimension: 'ordering' }), ctx(PARAMS));
    expect(res.status).toBe(200);

    // A retry replaces rather than appends: the dimension's rows go first...
    expect(prismaMock.appQuestionnaireEvaluationFinding.deleteMany).toHaveBeenCalledWith({
      where: { runId: 'run-1', dimension: 'ordering' },
    });
    // ...and the new rows continue the run's ordinal sequence (max was 4).
    const created = prismaMock.appQuestionnaireEvaluationFinding.createMany.mock.calls[0][0] as {
      data: { ordinal: number; dimension: string; runId: string }[];
    };
    expect(created.data).toHaveLength(1);
    expect(created.data[0]).toMatchObject({ ordinal: 5, dimension: 'ordering', runId: 'run-1' });

    // The run's summary entry is swapped for the verdict, and the tallies follow from it.
    const update = prismaMock.appQuestionnaireEvaluationRun.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: 'run-1' });
    expect(update.data).toMatchObject({
      status: 'completed',
      dimensionsRun: 2,
      dimensionsFailed: 0,
      totalFindings: 2,
      error: null,
    });
    expect(update.data.dimensionSummary).toEqual([
      { dimension: 'clarity', score: 0.8, findingCount: 1, diagnostic: null },
      { dimension: 'ordering', score: 0.7, findingCount: 1, diagnostic: null },
    ]);
    // `dimensionsRequested` is a fact about the run and never moves.
    expect(update.data).not.toHaveProperty('dimensionsRequested');
  });

  it('keeps the run partial and stores the FRESH diagnostic when the retry fails again', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'provider_timeout' },
    });

    const res = await POST(req({ dimension: 'ordering' }), ctx(PARAMS));
    expect(res.status).toBe(200);

    const update = prismaMock.appQuestionnaireEvaluationRun.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).toMatchObject({ status: 'partial', dimensionsRun: 1, dimensionsFailed: 1 });
    expect(update.data.dimensionSummary).toEqual([
      { dimension: 'clarity', score: 0.8, findingCount: 1, diagnostic: null },
      { dimension: 'ordering', score: null, findingCount: 0, diagnostic: 'provider_timeout' },
    ]);
    // No verdict means no findings to write — but the stale rows are still cleared.
    expect(prismaMock.appQuestionnaireEvaluationFinding.createMany).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireEvaluationFinding.deleteMany).toHaveBeenCalled();
  });

  it('returns the refreshed run detail, so the client can swap it in wholesale', async () => {
    const res = await POST(req({ dimension: 'ordering' }), ctx(PARAMS));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('run-1');
    expect(body.data.dimensionsFailed).toBe(0);
  });
});
