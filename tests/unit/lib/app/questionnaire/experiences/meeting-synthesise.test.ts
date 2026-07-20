/**
 * The breakout synthesiser (P15.5).
 *
 * The output of this call is read ALOUD to the people it describes, so the tests care most about
 * two things: that a bad model response can never reach the room, and that a failure never throws
 * at a facilitator standing in front of one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const llmMock = vi.hoisted(() => ({
  resolveAgentProviderAndModel: vi.fn(),
  getProvider: vi.fn(),
  runStructuredCompletion: vi.fn(),
  logCost: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: llmMock.resolveAgentProviderAndModel,
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: llmMock.getProvider }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: llmMock.logCost }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: llmMock.runStructuredCompletion,
}));

import { synthesiseBreakout } from '@/lib/app/questionnaire/experiences/meeting/synthesise';
import type { SynthesisMaterial } from '@/lib/app/questionnaire/experiences/meeting/synthesis-material';

/** Material with enough responses to clear the floor. */
function material(over: Partial<SynthesisMaterial> = {}): SynthesisMaterial {
  return {
    background: {
      questionnaireTitle: 'Team Health',
      goal: 'find the strain',
      breakoutTitle: 'Where are we stretched?',
      briefing: 'Be candid.',
      synthesisFocus: 'Look for workload disagreement.',
    },
    participantCount: 6,
    slots: [
      {
        key: 'workload',
        name: 'Workload',
        description: 'How stretched',
        theme: 'Capacity',
        respondedCount: 6,
        positions: [
          {
            participant: 'P1',
            text: 'stretched',
            confidence: 0.9,
            rationale: null,
            inferred: false,
          },
          { participant: 'P2', text: 'fine', confidence: 0.8, rationale: null, inferred: false },
          {
            participant: 'P3',
            text: 'stretched',
            confidence: 0.7,
            rationale: null,
            inferred: false,
          },
        ],
        movements: [],
      },
    ],
    ...over,
  };
}

function respondWith(insights: unknown[]) {
  llmMock.runStructuredCompletion.mockResolvedValue({
    value: { insights },
    tokenUsage: { input: 100, output: 50 },
    costUsd: 0.02,
  });
}

async function run(minSupport = 3, mat = material()) {
  return synthesiseBreakout({
    material: mat,
    minSupport,
    synthesisInstructions: '',
    meetingId: 'meet_1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.prisma.aiAgent.findUnique.mockResolvedValue({
    id: 'agent_1',
    provider: 'openai',
    model: 'gpt-5.4',
    fallbackProviders: [],
  });
  llmMock.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4',
  });
  llmMock.getProvider.mockResolvedValue({});
});

describe('the support gate', () => {
  it('drops findings below the threshold before they can be persisted', async () => {
    respondWith([
      { kind: 'agreement', statement: 'Most feel stretched', detail: null, supportCount: 4 },
      { kind: 'tension', statement: 'Two of you disagree', detail: null, supportCount: 2 },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => i.statement)).toEqual(['Most feel stretched']);
    expect(result.withheld).toBe(1);
  });

  it('CLAMPS a support count larger than the room', async () => {
    // A model claiming more support than there were people is either confused or inflating. The
    // number matters because the facilitator reads it out — "six of you" must be true.
    respondWith([
      { kind: 'agreement', statement: 'Everyone agrees', detail: null, supportCount: 999 },
    ]);

    const result = await run(3, material({ participantCount: 6 }));

    expect(result.insights[0].supportCount).toBe(6);
  });

  it('clamping cannot suppress a finding — only stop it overstating support', async () => {
    // Worth stating explicitly, because it is easy to assume otherwise. Clamping targets
    // `participantCount`, the floor check guarantees some slot has `respondedCount >= minSupport`,
    // and `respondedCount <= participantCount` — so a clamped count is ALWAYS >= the threshold.
    // The clamp is an honesty guard on the number the facilitator reads out ("four of you"), not a
    // second gate. The gate is the gate.
    respondWith([{ kind: 'tension', statement: 'A split', detail: null, supportCount: 99 }]);
    const small = material({
      participantCount: 2,
      slots: [{ ...material().slots[0], respondedCount: 2 }],
    });

    const result = await run(2, small);

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].supportCount).toBe(2);
    expect(result.withheld).toBe(0);
  });

  it('never calls the model when the room is below the floor', async () => {
    const thin = material({
      participantCount: 2,
      slots: [{ ...material().slots[0], respondedCount: 2 }],
    });

    const result = await run(3, thin);

    // Running it would spend money to produce findings the gate suppresses anyway.
    expect(llmMock.runStructuredCompletion).not.toHaveBeenCalled();
    expect(result).toEqual({ insights: [], withheld: 0, costUsd: 0 });
  });
});

describe('ordering and shape', () => {
  it('numbers the surviving findings from zero, in the model’s order', async () => {
    respondWith([
      { kind: 'tension', statement: 'First', detail: null, supportCount: 5 },
      { kind: 'agreement', statement: 'Second', detail: 'more', supportCount: 4 },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => [i.statement, i.ordinal])).toEqual([
      ['First', 0],
      ['Second', 1],
    ]);
  });

  it('renumbers contiguously after suppression — no gaps in the walkthrough', async () => {
    respondWith([
      { kind: 'tension', statement: 'Kept', detail: null, supportCount: 5 },
      { kind: 'outlier', statement: 'Dropped', detail: null, supportCount: 1 },
      { kind: 'theme', statement: 'Also kept', detail: null, supportCount: 4 },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => i.ordinal)).toEqual([0, 1]);
  });

  it('normalises a blank detail to null', async () => {
    respondWith([{ kind: 'agreement', statement: 'Something', detail: '   ', supportCount: 4 }]);
    expect((await run(3)).insights[0].detail).toBeNull();
  });

  it('reports the cost', async () => {
    respondWith([{ kind: 'agreement', statement: 'X', detail: null, supportCount: 4 }]);
    expect((await run(3)).costUsd).toBe(0.02);
  });
});

describe('failure is never an exception', () => {
  it('returns empty when the agent is not configured', async () => {
    prismaMock.prisma.aiAgent.findUnique.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ insights: [], withheld: 0, costUsd: 0 });
  });

  it('returns empty when no provider resolves', async () => {
    llmMock.resolveAgentProviderAndModel.mockRejectedValue(new Error('no provider'));
    await expect(run()).resolves.toEqual({ insights: [], withheld: 0, costUsd: 0 });
  });

  it('returns empty when the model call fails', async () => {
    // A facilitator standing in front of a room does not need an exception — the console shows
    // "no synthesis yet" and they can retry or carry on.
    llmMock.runStructuredCompletion.mockRejectedValue(new Error('timeout'));
    await expect(run()).resolves.toEqual({ insights: [], withheld: 0, costUsd: 0 });
  });

  it('handles a model returning no findings at all', async () => {
    // Saying nothing is a legitimate outcome — better than manufacturing a pattern.
    respondWith([]);
    const result = await run(3);
    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(0);
  });
});

describe('the prompt', () => {
  function systemPrompt(): string {
    return llmMock.runStructuredCompletion.mock.calls[0][0].messages[0].content;
  }

  it('tells the model never to name a participant', async () => {
    respondWith([]);
    await run(3);
    expect(systemPrompt()).toMatch(/NEVER name or number a participant/);
  });

  it('tells the model to count support honestly, and why', async () => {
    respondWith([]);
    await run(3);
    const prompt = systemPrompt();
    expect(prompt).toMatch(/HONESTLY/);
    expect(prompt).toMatch(/safe to say aloud/);
  });

  it('carries the breakout’s own synthesis focus', async () => {
    respondWith([]);
    await run(3);
    expect(systemPrompt()).toContain('Look for workload disagreement.');
  });

  it('states the room size so proportions have a denominator', async () => {
    respondWith([]);
    await run(3);
    expect(systemPrompt()).toContain('6 participant(s) completed this breakout');
  });

  it('includes movement as its own section, even when empty', async () => {
    respondWith([]);
    await run(3);
    expect(systemPrompt()).toContain('changes during the conversation');
  });
});
