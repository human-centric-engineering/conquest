/**
 * Integration test for the turn-evaluation service.
 *
 * Exercises `evaluateTurn` through the REAL `runStructuredCompletion` with only the provider,
 * the binding resolver, and the cost logger mocked — the same seam the design-evaluation
 * capability is tested at. Covers: happy path, the `reasoning` tier + binding pass-through,
 * malformed-JSON repair (retry-at-temp-0), no-silent-failure on final parse failure, and
 * cost logging with the session in metadata.
 *
 * @see lib/app/questionnaire/turn-evaluation/evaluate-turn.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
    isLocal: false,
  })),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { evaluateTurn } = await import('@/lib/app/questionnaire/turn-evaluation/evaluate-turn');
const { CostOperation } = await import('@/types/orchestration');

import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation/types';

type Mock = ReturnType<typeof vi.fn>;

const VALID_VERDICT = {
  overallScore: 82,
  effectiveness: 'Good',
  calls: [
    {
      name: 'Answer extraction',
      purpose: 'Map answer to slots',
      score: 80,
      instructionCompliance: 'Followed the schema.',
      outputQuality: 'Correct.',
      risks: 'Low.',
      improvements: 'None.',
    },
  ],
  interviewer: {
    openEndedness: 8,
    singleTopicFocus: 9,
    nonLeading: 7,
    conversational: 8,
    cognitiveLoad: 9,
    specificity: 7,
    warmth: 8,
    stageAlignment: 8,
    violations: [],
  },
  extraction: {
    score: 84,
    confidenceQuality: 'reasonable',
    coverage: 'Housing slot.',
    missedSignals: 'None.',
    overreach: 'None.',
  },
  questionSelection: {
    score: 79,
    relevance: 'Built on the answer.',
    coverageStrategy: 'Advanced coverage.',
    timing: 'Right moment.',
    alternatives: 'Tenure.',
  },
  informationGain: { rating: 'Medium', analysis: 'One slot.' },
  missedOpportunities: 'Cost burden.',
  promptDrift: { rating: 'None', evidence: [] },
  efficiency: { rating: 'Good', analysis: 'Justified.' },
  summary: {
    strengths: ['Clear'],
    weaknesses: ['Leading'],
    biggestRisk: 'Over-inference',
    biggestOpportunity: 'Probe cost',
    recommendedAction: 'Tighten rubric',
  },
};

interface ChatScript {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function makeProvider(scripts: ChatScript[]) {
  let turn = 0;
  return {
    chat: vi.fn(async () => {
      const script = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: script.content,
        usage: script.usage ?? { inputTokens: 100, outputTokens: 50 },
        model: 'test-model',
        finishReason: 'stop' as const,
      };
    }),
  };
}

const INPUT: TurnEvaluationInput = {
  turn: {
    turnIndex: 0,
    calls: [
      {
        label: 'Answer extraction',
        model: 'gpt-4o-mini',
        provider: 'openai',
        latencyMs: 400,
        costUsd: 0.001,
        prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
        response: '{"intents":[{"slotKey":"housing"}]}',
      },
    ],
  },
  context: { goal: 'Understand housing security' },
};

const AGENT = { provider: '', model: '', fallbackProviders: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as unknown as Mock).mockResolvedValue({
    providerSlug: 'anthropic',
    model: 'claude-x',
    fallbacks: [],
  });
});

describe('evaluateTurn', () => {
  it('returns the validated verdict on the happy path', async () => {
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify(VALID_VERDICT) }])
    );

    const result = await evaluateTurn(INPUT, AGENT, { agentId: 'agent-1', sessionId: 'sess-1' });

    expect(result.verdict.overallScore).toBe(82);
    expect(result.verdict.effectiveness).toBe('Good');
    expect(result.model).toBe('claude-x');
    expect(result.provider).toBe('anthropic');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('resolves the binding on the reasoning tier', async () => {
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify(VALID_VERDICT) }])
    );

    await evaluateTurn(INPUT, AGENT);

    expect(resolveAgentProviderAndModel).toHaveBeenCalledWith(AGENT, 'reasoning');
  });

  it('repairs a malformed first response by retrying once', async () => {
    const provider = makeProvider([
      { content: 'not json at all' },
      { content: JSON.stringify(VALID_VERDICT) },
    ]);
    (getProvider as unknown as Mock).mockResolvedValue(provider);

    const result = await evaluateTurn(INPUT, AGENT);

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.verdict.overallScore).toBe(82);
  });

  it('throws (no silent failure) when both attempts fail to parse', async () => {
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: 'garbage' }, { content: 'still garbage' }])
    );

    await expect(evaluateTurn(INPUT, AGENT)).rejects.toThrow(/not valid against the schema/i);
  });

  it('names the invalid field paths when both attempts parse as JSON but fail the schema', async () => {
    // `{}` parses but is missing every required field — the validator populates issue paths,
    // which the final-failure error surfaces.
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: '{}' }, { content: '{}' }])
    );

    await expect(evaluateTurn(INPUT, AGENT)).rejects.toThrow(/invalid at: .*overallScore/i);
  });

  it('still returns the verdict when the fire-and-forget cost log rejects', async () => {
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify(VALID_VERDICT) }])
    );
    // Reject with a non-Error to also exercise the String() coercion in errorMessage.
    (logCost as unknown as Mock).mockRejectedValue('accounting offline');

    const result = await evaluateTurn(INPUT, AGENT, { agentId: 'agent-1', sessionId: 'sess-1' });

    expect(result.verdict.overallScore).toBe(82);
    // Let the fire-and-forget logCost rejection settle so its .catch handler runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('logs cost with the session id and turn index in metadata', async () => {
    (getProvider as unknown as Mock).mockResolvedValue(
      makeProvider([{ content: JSON.stringify(VALID_VERDICT) }])
    );

    await evaluateTurn(INPUT, AGENT, { agentId: 'agent-1', sessionId: 'sess-1' });

    expect(logCost).toHaveBeenCalledTimes(1);
    const arg = (logCost as unknown as Mock).mock.calls[0][0];
    expect(arg).toMatchObject({
      agentId: 'agent-1',
      operation: CostOperation.CHAT,
      provider: 'anthropic',
      model: 'claude-x',
    });
    expect(arg.metadata).toMatchObject({
      capability: 'turn-evaluation',
      sessionId: 'sess-1',
      turnIndex: 0,
    });
  });
});
