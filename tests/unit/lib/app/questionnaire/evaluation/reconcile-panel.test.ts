/**
 * Unit test: the reconcile step inside `runEvaluationPanel`.
 *
 * The panel's own fan-out is covered in `run-panel.test.ts`; this file is about the extra call that
 * follows it — which questions it picks up, which it leaves alone, and the several ways it is
 * allowed to fail without taking the run down with it.
 *
 * The last part matters most. An admin has just paid for seven judge calls by the time this step
 * runs, so every failure path here has to end in "the run returns, unreconciled" — never in a lost
 * panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

import {
  runEvaluationPanel,
  type JudgeAgentRef,
} from '@/lib/app/questionnaire/evaluation/run-panel';
import {
  EVALUATION_DIMENSION_SPECS,
  MAX_RECONCILED_TARGETS,
  type EvaluationDimension,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';
import {
  RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
  RECONCILER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { Logger } from '@/lib/logging';

const logFns = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const log = logFns as unknown as Logger;

/** A structure with enough questions to exercise the cap. */
function structureOf(count: number): VersionStructureInput {
  return {
    goal: 'Understand onboarding friction.',
    audience: null,
    sections: [
      {
        title: 'Background',
        questions: Array.from({ length: count }, (_, i) => ({
          key: `q${i + 1}`,
          prompt: `Prompt ${i + 1}?`,
          type: 'free_text',
          required: true,
        })),
      },
    ],
  };
}

/** Two sections, so section-relative and questionnaire-global numbering disagree. */
function twoSectionStructure(): VersionStructureInput {
  return {
    goal: 'Understand onboarding friction.',
    audience: null,
    sections: [
      {
        title: 'Background',
        questions: [
          { key: 'q1', prompt: 'Prompt 1?', type: 'free_text', required: true },
          { key: 'q2', prompt: 'Prompt 2?', type: 'free_text', required: true },
        ],
      },
      {
        title: 'Working life',
        questions: [{ key: 'q3', prompt: 'Prompt 3?', type: 'free_text', required: true }],
      },
    ],
  };
}

function agentFor(dimension: EvaluationDimension): JudgeAgentRef {
  return {
    slug: EVALUATION_DIMENSION_SPECS[dimension].slug,
    id: `agent-${dimension}`,
    provider: '',
    model: '',
    fallbackProviders: [],
  };
}

/** Judges plus the reconciler — the map the routes build from one OR'd query. */
function agentsWithReconciler(dimensions: EvaluationDimension[]): Map<string, JudgeAgentRef> {
  const map = new Map<string, JudgeAgentRef>(
    dimensions.map((d) => [EVALUATION_DIMENSION_SPECS[d].slug, agentFor(d)])
  );
  map.set(RECONCILER_AGENT_SLUG, {
    slug: RECONCILER_AGENT_SLUG,
    id: 'agent-reconciler',
    provider: 'openai',
    model: 'gpt-5.4',
    fallbackProviders: [],
  });
  return map;
}

/** A judge verdict flagging the given keys. */
function verdictFor(dimension: string, targetKeys: string[], severity = 'minor') {
  return {
    success: true,
    data: {
      verdict: {
        dimension,
        score: 0.6,
        findings: targetKeys.map((targetKey) => ({
          targetKey,
          severity,
          proposedChange: `Reword ${targetKey} for ${dimension}.`,
          rationale: `${dimension} concern about ${targetKey}.`,
        })),
      },
    },
  };
}

const RECONCILED = {
  targetKey: 'q1',
  alternatives: [
    {
      prompt: 'A single, plainly worded question?',
      addresses: ['clarity', 'audience_match'],
      note: 'One ask, no jargon.',
    },
  ],
  unresolved: [],
};

/**
 * Route every judge dimension to `judgeTargets`, and answer the reconcile dispatch with
 * `reconcileResponse`. Returns the recorded reconcile args for assertions.
 */
function wireDispatch(options: {
  judgeTargets: Record<string, string[]>;
  reconcileResponse?: unknown;
  reconcileThrows?: boolean;
}) {
  const calls: { slug: string; args: Record<string, unknown> }[] = [];
  dispatchMock.capabilityDispatcher.dispatch.mockImplementation((slug, args) => {
    calls.push({ slug: slug as string, args: args as Record<string, unknown> });
    if (slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG) {
      if (options.reconcileThrows) return Promise.reject(new Error('reconciler exploded'));
      return Promise.resolve(
        options.reconcileResponse ?? { success: true, data: { suggestions: [RECONCILED] } }
      );
    }
    const dimension = (args as { dimension: string }).dimension;
    return Promise.resolve(verdictFor(dimension, options.judgeTargets[dimension] ?? []));
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(logFns).forEach((fn) => fn.mockReset());
});

const TWO: EvaluationDimension[] = ['clarity', 'audience_match'];

describe('runEvaluationPanel — cross-judge reconciliation', () => {
  it('reconciles a question two judges flagged, and returns the alternatives on the run', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const reconcile = calls.find((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG);
    expect(reconcile).toBeDefined();
    const targets = reconcile?.args.targets as { key: string; judges: unknown[] }[];
    expect(targets).toHaveLength(1);
    expect(targets[0].key).toBe('q1');
    // Both verdicts travel, or the reconciler is reconciling one opinion with itself.
    expect(targets[0].judges).toHaveLength(2);
    expect(result.reconciled).toEqual([RECONCILED]);
  });

  it('sends the current wording and the questionnaire framing, not just the complaints', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const reconcile = calls.find((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG);
    const targets = reconcile?.args.targets as {
      prompt: string;
      questionType: string | null;
      context: string | null;
    }[];
    // Without the current wording there is nothing to rewrite; without goal/audience the
    // alternatives would drift outside the frame every judge was scoring against.
    expect(targets[0].prompt).toBe('Prompt 1?');
    expect(targets[0].questionType).toBe('free_text');
    expect(targets[0].context).toBe('Q1 · Background');
    expect(reconcile?.args.goal).toBe('Understand onboarding friction.');
  });

  it('does not reconcile a question only one judge flagged', async () => {
    // That question already carries its judge's own rewrite. There is no disagreement to resolve,
    // and spending a call to restate one opinion is pure cost.
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q2'] } });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
    expect(result.reconciled).toEqual([]);
  });

  it('counts judges, not findings — one judge raising two points is still one perspective', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1', 'q1'], audience_match: ['q2'] } });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
  });

  it('ignores findings against the goal, the audience, or a key that is not a question', async () => {
    // Coverage-gap findings are addressed at `goal` by convention, and a question that does not
    // exist yet cannot be rephrased. Neither is a wording problem for this step to solve.
    const calls = wireDispatch({
      judgeTargets: { clarity: ['goal'], audience_match: ['goal'] },
    });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
    expect(result.reconciled).toEqual([]);
  });

  it('caps the batch and says out loud how many contested questions it left out', async () => {
    // A silent cap is the dangerous version of this: an admin reading 15 reconciled questions
    // would take the other 5 for questions the panel was happy with.
    const overCap = MAX_RECONCILED_TARGETS + 5;
    const keys = Array.from({ length: overCap }, (_, i) => `q${i + 1}`);
    const calls = wireDispatch({ judgeTargets: { clarity: keys, audience_match: keys } });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(overCap),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const reconcile = calls.find((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG);
    expect((reconcile?.args.targets as unknown[]).length).toBe(MAX_RECONCILED_TARGETS);
    expect(logFns.info).toHaveBeenCalledWith(
      'Reconciling the most contested questions only',
      expect.objectContaining({ contested: overCap, reconciled: MAX_RECONCILED_TARGETS })
    );
  });

  it('puts the questions with major findings at the front of the batch', async () => {
    // When the cap bites, it should bite on the least serious questions.
    const calls: { slug: string; args: Record<string, unknown> }[] = [];
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((slug, args) => {
      calls.push({ slug: slug as string, args: args as Record<string, unknown> });
      if (slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG) {
        return Promise.resolve({ success: true, data: { suggestions: [] } });
      }
      const dimension = (args as { dimension: string }).dimension;
      // q1 is a minor concern for both judges; q2 is major for both.
      return Promise.resolve({
        success: true,
        data: {
          verdict: {
            dimension,
            score: 0.5,
            findings: [
              {
                targetKey: 'q1',
                severity: 'minor',
                proposedChange: 'x',
                rationale: 'y',
              },
              {
                targetKey: 'q2',
                severity: 'major',
                proposedChange: 'x',
                rationale: 'y',
              },
            ],
          },
        },
      });
    });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const reconcile = calls.find((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG);
    const keys = (reconcile?.args.targets as { key: string }[]).map((t) => t.key);
    expect(keys).toEqual(['q2', 'q1']);
  });

  it('returns the panel unreconciled when the reconciler agent is not seeded', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });
    const judgesOnly = new Map(
      TWO.map((d) => [EVALUATION_DIMENSION_SPECS[d].slug, agentFor(d)] as const)
    );

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: judgesOnly,
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
    expect(result.reconciled).toEqual([]);
    // The judges' work survives intact — that is the whole point of failing soft here.
    expect(result.summary.dimensionsRun).toBe(2);
    expect(result.summary.totalFindings).toBe(2);
    expect(logFns.warn).toHaveBeenCalled();
  });

  it('returns the panel unreconciled when the reconcile dispatch fails', async () => {
    wireDispatch({
      judgeTargets: { clarity: ['q1'], audience_match: ['q1'] },
      reconcileResponse: { success: false, error: { code: 'reconciliation_failed' } },
    });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(result.reconciled).toEqual([]);
    expect(result.summary.totalFindings).toBe(2);
  });

  it('returns the panel unreconciled when the reconcile dispatch throws', async () => {
    wireDispatch({
      judgeTargets: { clarity: ['q1'], audience_match: ['q1'] },
      reconcileThrows: true,
    });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(result.reconciled).toEqual([]);
    expect(result.summary.dimensionsRun).toBe(2);
    expect(logFns.error).toHaveBeenCalled();
  });

  it('treats a shapeless success payload as nothing reconciled rather than trusting the cast', async () => {
    // `dispatch.data` is `unknown` at this seam. A payload without `suggestions` must not reach a
    // `.length` and take the run down.
    wireDispatch({
      judgeTargets: { clarity: ['q1'], audience_match: ['q1'] },
      reconcileResponse: { success: true, data: { nonsense: true } },
    });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    expect(result.reconciled).toEqual([]);
    expect(result.summary.dimensionsRun).toBe(2);
  });

  it('passes the reconciler binding through the dispatch context, not the judges’', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(1),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const call = dispatchMock.capabilityDispatcher.dispatch.mock.calls.find(
      ([slug]) => slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG
    );
    const context = call?.[2] as {
      agentId: string;
      entityContext: { reconcilerAgent: { model: string } };
    };
    expect(context.agentId).toBe('agent-reconciler');
    expect(context.entityContext.reconcilerAgent.model).toBe('gpt-5.4');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('runEvaluationPanel — reconciliation is gated, not assumed', () => {
  it('numbers a question within its section, matching the chip the admin reads', async () => {
    // Every other surface derives the chip from `indexInSection + 1` (`resolveFindingTarget`). A
    // counter running across sections made the reconciler's prompt say "Q3 · Working life" for the
    // question the card labels "Q1 · Working life", so an alternative whose note cited the number
    // contradicted the card carrying it.
    const calls = wireDispatch({ judgeTargets: { clarity: ['q3'], audience_match: ['q3'] } });

    await runEvaluationPanel({
      dimensions: TWO,
      structure: twoSectionStructure(),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: true,
    });

    const reconcile = calls.find((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG);
    const targets = reconcile?.args.targets as { key: string; context: string }[];
    expect(targets[0].context).toBe('Q1 · Working life');
  });

  it('does not dispatch the reconciler at all when the caller opts out', async () => {
    // The preview route pays for the panel and returns `{ results, summary }` only, so a reconcile
    // call there is billed and then dropped on the floor.
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    const result = await runEvaluationPanel({
      dimensions: TWO,
      structure: structureOf(2),
      questionnaireId: 'qn1',
      versionId: 'v1',
      agentBySlug: agentsWithReconciler(TWO),
      adminId: 'admin-1',
      log,
      reconcile: false,
    });

    expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
    expect(result.reconciled).toEqual([]);
    // The judges still ran and still returned — opting out costs nothing else.
    expect(result.summary.totalFindings).toBe(2);
  });

  it('skips reconciliation when the judges have already spent the run’s wall-clock', async () => {
    // Judges fan out concurrently but a slow one can retry to 180s, and reconcile runs serially
    // after them for up to another 180s — past both routes' 300s `maxDuration`. Being killed there
    // would throw away seven judge calls the admin has already paid for, so the step stands down.
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    const realNow = Date.now.bind(Date);
    const t0 = realNow();
    let first = true;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (first) {
        first = false;
        return t0; // panel start
      }
      return t0 + 200_000; // the judges took 200s, leaving 85s of a 285s budget
    });

    try {
      const result = await runEvaluationPanel({
        dimensions: TWO,
        structure: structureOf(2),
        questionnaireId: 'qn1',
        versionId: 'v1',
        agentBySlug: agentsWithReconciler(TWO),
        adminId: 'admin-1',
        log,
        reconcile: true,
      });

      expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(false);
      // Degrades exactly as a failed reconcile does: the judges' own suggestions stand.
      expect(result.reconciled).toEqual([]);
      expect(result.summary.totalFindings).toBe(2);
      expect(logFns.warn).toHaveBeenCalledWith(
        'Skipping cross-judge reconciliation: panel left too little wall-clock',
        expect.objectContaining({ elapsedMs: 200_000 })
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('still reconciles when the judges came back quickly', async () => {
    const calls = wireDispatch({ judgeTargets: { clarity: ['q1'], audience_match: ['q1'] } });

    const realNow = Date.now.bind(Date);
    const t0 = realNow();
    let first = true;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (first) {
        first = false;
        return t0;
      }
      return t0 + 40_000; // 40s in — the ordinary case
    });

    try {
      const result = await runEvaluationPanel({
        dimensions: TWO,
        structure: structureOf(2),
        questionnaireId: 'qn1',
        versionId: 'v1',
        agentBySlug: agentsWithReconciler(TWO),
        adminId: 'admin-1',
        log,
        reconcile: true,
      });

      expect(calls.some((c) => c.slug === RECONCILE_SUGGESTIONS_CAPABILITY_SLUG)).toBe(true);
      expect(result.reconciled).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
