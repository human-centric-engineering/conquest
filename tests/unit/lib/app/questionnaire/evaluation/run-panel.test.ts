/**
 * Unit test: the shared judge-panel dispatch (F5.2 extraction of the F5.1 fan-out).
 *
 * Exercises `runEvaluationPanel` directly with the capability dispatcher mocked — the
 * concurrent fan-out (one dispatch per dimension), the summary tallies, and the three
 * fail-soft paths: a missing agent (`judge_not_configured`), a `{ success: false }`
 * envelope (its error code), and a thrown dispatch (`dispatch_error`). The route → loader
 * wiring is pinned separately in the route integration test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

import {
  runEvaluationPanel,
  type JudgeAgentRef,
} from '@/lib/app/questionnaire/evaluation/run-panel';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';
import type { Logger } from '@/lib/logging';

// Separate the mock fns from the cast so `beforeEach` can reset them — bare `vi.fn()`s
// on a cast object are not reset by `vi.clearAllMocks()`, which would let call counts
// accumulate across cases if a future test ever asserts on `log`.
const logFns = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const log = logFns as unknown as Logger;

const structure: VersionStructureInput = {
  goal: 'Understand onboarding friction.',
  audience: null,
  sections: [
    {
      title: 'Background',
      questions: [
        { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
      ],
    },
  ],
};

/** A judge-agent ref for one dimension, as the route's findMany returns it. */
function agentFor(dimension: EvaluationDimension): JudgeAgentRef {
  return {
    slug: EVALUATION_DIMENSION_SPECS[dimension].slug,
    id: `agent-${dimension}`,
    provider: '',
    model: '',
    fallbackProviders: [],
  };
}

/** A map of all seven judge agents keyed by slug. */
function allAgents(): Map<string, JudgeAgentRef> {
  return new Map(
    EVALUATION_DIMENSIONS.map((d) => [EVALUATION_DIMENSION_SPECS[d].slug, agentFor(d)])
  );
}

function dispatchSuccess(dimension: string, findingCount = 1) {
  return {
    success: true,
    data: {
      verdict: {
        dimension,
        score: 0.8,
        findings: Array.from({ length: findingCount }, () => ({
          targetKey: 'q_role',
          severity: 'minor',
          proposedChange: 'Tighten wording.',
          rationale: 'Slightly vague.',
        })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(logFns).forEach((fn) => fn.mockReset());
  dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) =>
    Promise.resolve(dispatchSuccess((args as { dimension: string }).dimension))
  );
});

describe('runEvaluationPanel', () => {
  it('dispatches one judge per dimension and tallies the summary', async () => {
    const dimensions = [...EVALUATION_DIMENSIONS];
    const result = await runEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });

    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(dimensions.length);
    expect(result.results).toHaveLength(dimensions.length);
    expect(result.summary).toEqual({
      dimensionsRequested: dimensions.length,
      dimensionsRun: dimensions.length,
      dimensionsFailed: 0,
      totalFindings: dimensions.length, // one finding per judge
    });
    for (const r of result.results) {
      expect(r.verdict?.dimension).toBe(r.dimension);
      expect(r.diagnostic).toBeUndefined();
    }
  });

  it('passes the provider binding through the dispatch entityContext', async () => {
    await runEvaluationPanel({
      dimensions: ['clarity'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: new Map([
        [
          EVALUATION_DIMENSION_SPECS.clarity.slug,
          {
            ...agentFor('clarity'),
            provider: 'openai',
            model: 'gpt-x',
            fallbackProviders: ['anthropic'],
          },
        ],
      ]),
      adminId: 'admin-1',
      log,
    });
    const [, , ctx] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(ctx).toMatchObject({
      userId: 'admin-1',
      agentId: 'agent-clarity',
      entityContext: {
        judgeAgent: { provider: 'openai', model: 'gpt-x', fallbackProviders: ['anthropic'] },
      },
    });
  });

  it('returns judge_not_configured for a dimension whose agent is absent', async () => {
    // Only clarity seeded; request clarity + ordering.
    const agents = new Map([[EVALUATION_DIMENSION_SPECS.clarity.slug, agentFor('clarity')]]);
    const result = await runEvaluationPanel({
      dimensions: ['clarity', 'ordering'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: agents,
      adminId: 'admin-1',
      log,
    });
    const ordering = result.results.find((r) => r.dimension === 'ordering');
    expect(ordering?.diagnostic).toBe('judge_not_configured');
    expect(ordering?.verdict).toBeUndefined();
    // The missing judge is never dispatched.
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('returns the error code for a { success: false } dispatch, others still run', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'coverage') {
        return Promise.resolve({ success: false, error: { code: 'evaluation_failed' } });
      }
      return Promise.resolve(dispatchSuccess(dimension));
    });
    const result = await runEvaluationPanel({
      dimensions: ['clarity', 'coverage'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    const coverage = result.results.find((r) => r.dimension === 'coverage');
    const clarity = result.results.find((r) => r.dimension === 'clarity');
    expect(coverage?.diagnostic).toBe('evaluation_failed');
    expect(clarity?.verdict).toMatchObject({ dimension: 'clarity', score: expect.any(Number) });
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('degrades a thrown dispatch to dispatch_error instead of rejecting the whole panel', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'coverage') return Promise.reject(new Error('registry load failed'));
      return Promise.resolve(dispatchSuccess(dimension));
    });
    const result = await runEvaluationPanel({
      dimensions: ['clarity', 'coverage'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    const coverage = result.results.find((r) => r.dimension === 'coverage');
    expect(coverage?.diagnostic).toBe('dispatch_error');
    expect(coverage?.verdict).toBeUndefined();
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('falls back to evaluation_failed when a failed dispatch carries no error code', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({ success: false });
    const result = await runEvaluationPanel({
      dimensions: ['clarity'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    expect(result.results[0].diagnostic).toBe('evaluation_failed');
  });

  it('treats success:true with no data as a diagnostic (the && data guard falls through)', async () => {
    // CapabilityResult.data is optional — { success: true } without data is valid and must
    // not be read as a verdict; it falls through to the diagnostic path.
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({ success: true });
    const result = await runEvaluationPanel({
      dimensions: ['clarity'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    expect(result.results[0].verdict).toBeUndefined();
    expect(result.results[0].diagnostic).toBe('evaluation_failed');
    expect(result.summary.dimensionsRun).toBe(0);
  });
});
