/**
 * Unit test: the scope-evaluation judge-panel dispatch (F17.21).
 *
 * Exercises `runScopeEvaluationPanel` directly with the capability dispatcher mocked — the
 * concurrent fan-out (one dispatch per dimension), the summary tallies, and the three fail-soft
 * paths: a missing agent (`judge_not_configured`), a `{ success: false }` envelope (its error
 * code), and a thrown dispatch (`dispatch_error`). Mirrors `evaluation/run-panel.test.ts`, minus
 * the reconcile step — the scope panel has none (see `run-panel.ts`'s module doc).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

// The panel flushes capability handlers before dispatching; here it's a no-op so the
// mocked dispatcher stands alone (the real flush is covered by the registry's own tests).
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

import { runScopeEvaluationPanel } from '@/lib/app/questionnaire/scope-evaluation/run-panel';
import type { ScopeJudgeAgentRef } from '@/lib/app/questionnaire/scope-evaluation/run-panel';
import {
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeEvaluationDimension,
  type ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation';
import type { Logger } from '@/lib/logging';

const logFns = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const log = logFns as unknown as Logger;

const structure: ScopeStructureInput = {
  topics: [
    {
      key: 'background',
      label: 'Background',
      phase: 'opening',
      criteria: null,
      depth: 'full',
      members: [],
    },
  ],
  rules: [],
  settings: {
    maxConditionalTopics: 3,
    includeCheckTopic: true,
    fallbackTopicKeys: [],
    minConfidence: 0.6,
    plannerInstructions: '',
    sessionBudgetSeconds: 600,
    limitOpeningProbes: false,
    maxOpeningProbes: 1,
  },
  costs: { budgetSeconds: 600, alwaysSeconds: 60, routedAllowanceSeconds: 540, perTopic: [] },
  knownIssues: [],
};

/** A judge-agent ref for one dimension, as the route's findMany returns it. */
function agentFor(dimension: ScopeEvaluationDimension): ScopeJudgeAgentRef {
  return {
    slug: SCOPE_EVALUATION_DIMENSION_SPECS[dimension].slug,
    id: `agent-${dimension}`,
    provider: '',
    model: '',
    fallbackProviders: [],
  };
}

/** A map of all four judge agents keyed by slug. */
function allAgents(): Map<string, ScopeJudgeAgentRef> {
  return new Map(
    SCOPE_EVALUATION_DIMENSIONS.map((d) => [SCOPE_EVALUATION_DIMENSION_SPECS[d].slug, agentFor(d)])
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
          targetKey: 'settings',
          severity: 'minor',
          proposedChange: 'Tighten the budget.',
          rationale: 'Slightly loose.',
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

describe('runScopeEvaluationPanel', () => {
  it('dispatches one judge per dimension and tallies the summary', async () => {
    const dimensions = [...SCOPE_EVALUATION_DIMENSIONS];
    const result = await runScopeEvaluationPanel({
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
    await runScopeEvaluationPanel({
      dimensions: ['criteria_quality'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: new Map([
        [
          SCOPE_EVALUATION_DIMENSION_SPECS.criteria_quality.slug,
          {
            ...agentFor('criteria_quality'),
            provider: 'openai',
            model: 'gpt-x',
            fallbackProviders: ['anthropic'],
          },
        ],
      ]),
      adminId: 'admin-1',
      log,
    });
    const [slug, args, ctx] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_evaluate_scope');
    expect(args).toMatchObject({ dimension: 'criteria_quality', versionId: 'v1' });
    expect(ctx).toMatchObject({
      userId: 'admin-1',
      agentId: 'agent-criteria_quality',
      entityContext: {
        judgeAgent: { provider: 'openai', model: 'gpt-x', fallbackProviders: ['anthropic'] },
      },
    });
  });

  it('returns judge_not_configured for a dimension whose agent is absent', async () => {
    // Only criteria_quality seeded; request criteria_quality + rule_integrity.
    const agents = new Map([
      [SCOPE_EVALUATION_DIMENSION_SPECS.criteria_quality.slug, agentFor('criteria_quality')],
    ]);
    const result = await runScopeEvaluationPanel({
      dimensions: ['criteria_quality', 'rule_integrity'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: agents,
      adminId: 'admin-1',
      log,
    });
    const ruleIntegrity = result.results.find((r) => r.dimension === 'rule_integrity');
    expect(ruleIntegrity?.diagnostic).toBe('judge_not_configured');
    expect(ruleIntegrity?.verdict).toBeUndefined();
    // The missing judge is never dispatched.
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('returns the error code for a { success: false } dispatch, others still run', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'budget_realism') {
        return Promise.resolve({ success: false, error: { code: 'evaluation_failed' } });
      }
      return Promise.resolve(dispatchSuccess(dimension));
    });
    const result = await runScopeEvaluationPanel({
      dimensions: ['criteria_quality', 'budget_realism'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    const budget = result.results.find((r) => r.dimension === 'budget_realism');
    const criteria = result.results.find((r) => r.dimension === 'criteria_quality');
    expect(budget?.diagnostic).toBe('evaluation_failed');
    expect(criteria?.verdict).toMatchObject({
      dimension: 'criteria_quality',
      score: expect.any(Number),
    });
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('degrades a thrown dispatch to dispatch_error instead of rejecting the whole panel', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockImplementation((_slug, args) => {
      const dimension = (args as { dimension: string }).dimension;
      if (dimension === 'budget_realism') return Promise.reject(new Error('registry load failed'));
      return Promise.resolve(dispatchSuccess(dimension));
    });
    const result = await runScopeEvaluationPanel({
      dimensions: ['criteria_quality', 'budget_realism'],
      structure,
      questionnaireId: 'qn-1',
      versionId: 'v1',
      agentBySlug: allAgents(),
      adminId: 'admin-1',
      log,
    });
    const budget = result.results.find((r) => r.dimension === 'budget_realism');
    expect(budget?.diagnostic).toBe('dispatch_error');
    expect(budget?.verdict).toBeUndefined();
    expect(result.summary.dimensionsRun).toBe(1);
    expect(result.summary.dimensionsFailed).toBe(1);
  });

  it('falls back to evaluation_failed when a failed dispatch carries no error code', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({ success: false });
    const result = await runScopeEvaluationPanel({
      dimensions: ['criteria_quality'],
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
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({ success: true });
    const result = await runScopeEvaluationPanel({
      dimensions: ['criteria_quality'],
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
