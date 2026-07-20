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
        // All six labels appear, because support is now VERIFIED against the labels the material
        // actually contains — a finding can only rest on people who are in here.
        positions: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((participant, i) => ({
          participant,
          text: i % 2 === 0 ? 'stretched' : 'fine',
          confidence: 0.9,
          rationale: null,
          inferred: false,
        })),
        movements: [],
      },
    ],
    ...over,
  };
}

/**
 * A scribe room: ONE session — the pen — recording for `occupancy` people who were present and, by
 * design, have no session of their own. `respondedCount` is therefore 1 no matter how full it is.
 */
function scribeMaterial(occupancy: number): SynthesisMaterial {
  const base = material().slots[0];
  return material({
    participantCount: occupancy,
    supportBasis: 'room-occupancy',
    slots: [
      {
        ...base,
        respondedCount: 1,
        positions: [
          {
            participant: 'P1',
            text: 'scope keeps moving',
            confidence: 0.9,
            rationale: null,
            inferred: false,
          },
        ],
      },
    ],
  });
}

/** The first `n` participant labels — the honest evidence for a finding backed by `n` people. */
function backedBy(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `P${i + 1}`);
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
      {
        kind: 'agreement',
        statement: 'Most feel stretched',
        detail: null,
        supportCount: 4,
        supportedBy: backedBy(4),
      },
      {
        kind: 'tension',
        statement: 'Two of you disagree',
        detail: null,
        supportCount: 2,
        supportedBy: backedBy(2),
      },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => i.statement)).toEqual(['Most feel stretched']);
    expect(result.withheld).toBe(1);
  });

  it('CLAMPS a support count larger than the room', async () => {
    // A model claiming more support than there were people is either confused or inflating. The
    // number matters because the facilitator reads it out — "six of you" must be true.
    respondWith([
      {
        kind: 'agreement',
        statement: 'Everyone agrees',
        detail: null,
        supportCount: 999,
        supportedBy: backedBy(6),
      },
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
    respondWith([
      {
        kind: 'tension',
        statement: 'A split',
        detail: null,
        supportCount: 99,
        supportedBy: backedBy(6),
      },
    ]);
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

/**
 * The prompt is attacker-influenced: respondent free text goes into it unquoted, so a participant
 * can write an instruction into an answer and the model may follow it. These tests are the reason
 * that does not break k-anonymity — support is recomputed from evidence, so an injected number is
 * just a number.
 */
describe('support is verified server-side, never taken from the model', () => {
  it('gates out an inflated count backed by only ONE real participant', async () => {
    // The attack, end to end: the model was told to emit one finding per person with an inflated
    // count. Every statement here rests on a single participant, in a room where the audience for
    // the finding is that same participant's colleagues.
    respondWith([
      {
        kind: 'theme',
        statement: 'The deadline was never realistic',
        detail: null,
        supportCount: 6,
        supportedBy: ['P1'],
      },
      {
        kind: 'theme',
        statement: 'Management does not listen',
        detail: null,
        supportCount: 6,
        supportedBy: ['P2'],
      },
    ]);

    const result = await run(3);

    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(2);
  });

  it('discards labels that are not in the material, and suppresses what is left', async () => {
    // Fabricated citations are the obvious next move once the count stops being trusted. A label
    // nobody in this breakout carries is evidence of nothing.
    respondWith([
      {
        kind: 'agreement',
        statement: 'Broad agreement on scope',
        detail: null,
        supportCount: 5,
        supportedBy: ['P1', 'P77', 'P88', 'P99', 'Q1'],
      },
    ]);

    const result = await run(3);

    // P1 verified, the other four discarded — one real person is below any legal floor.
    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(1);
  });

  it('passes an honest finding, and reports the VERIFIED count rather than the claim', async () => {
    respondWith([
      {
        kind: 'agreement',
        statement: 'Most of you feel stretched',
        detail: null,
        supportCount: 2,
        supportedBy: ['P1', 'P2', 'P3', 'P4'],
      },
    ]);

    const result = await run(3);

    expect(result.insights).toHaveLength(1);
    // Not 2. The model's number is dropped in both directions — the facilitator reads out what the
    // evidence supports.
    expect(result.insights[0].supportCount).toBe(4);
  });

  it('counts DISTINCT participants — a repeated label is one person', async () => {
    respondWith([
      {
        kind: 'theme',
        statement: 'Padded with duplicates',
        detail: null,
        supportCount: 4,
        supportedBy: ['P1', 'P1', 'P1', 'P1', 'p1'],
      },
    ]);

    const result = await run(3);

    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(1);
  });

  it('matches labels case-insensitively, so honest casing drift does not suppress', async () => {
    respondWith([
      {
        kind: 'agreement',
        statement: 'Three of you said the same thing',
        detail: null,
        supportCount: 3,
        supportedBy: [' p1 ', 'P2', 'p3'],
      },
    ]);

    expect((await run(3)).insights[0].supportCount).toBe(3);
  });

  it('suppresses a finding that cites nobody at all', async () => {
    // Fails closed: no evidence is not weak evidence, it is none.
    respondWith([
      {
        kind: 'theme',
        statement: 'A pattern with no evidence',
        detail: null,
        supportCount: 6,
        supportedBy: [],
      },
    ]);

    const result = await run(3);

    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(1);
  });

  it('credits a participant known only from a movement', async () => {
    // Somebody who CHANGED their mind is a real person backing a finding about the change, even if
    // no final position was recorded for them.
    const withMovement = material({
      slots: [
        {
          ...material().slots[0],
          positions: [material().slots[0].positions[0]],
          movements: ['P2', 'P3'].map((participant) => ({
            participant,
            from: 'fine',
            to: 'stretched',
            rationale: 'heard the others',
            confidenceBefore: 0.5,
            confidenceAfter: 0.9,
          })),
        },
      ],
    });
    respondWith([
      {
        kind: 'tension',
        statement: 'Some of you shifted during the conversation',
        detail: null,
        supportCount: 3,
        supportedBy: ['P1', 'P2', 'P3'],
      },
    ]);

    expect((await run(3, withMovement)).insights[0].supportCount).toBe(3);
  });

  it('refuses to parse a response that omits `supportedBy` entirely', async () => {
    // Driven through the real `parse` callback the synthesiser hands to the completion runner, so
    // this asserts the shipped schema and not a copy of it. A finding with nothing to verify must
    // not become a finding — the runner retries, and gives up rather than guessing.
    respondWith([]);
    await run(3);
    const parse = llmMock.runStructuredCompletion.mock.calls[0][0].parse;

    expect(
      parse(
        JSON.stringify({
          insights: [{ kind: 'theme', statement: 'Unverifiable', detail: null, supportCount: 6 }],
        })
      )
    ).toBeNull();

    // The same finding WITH citations parses, so the rejection is about the missing evidence and
    // nothing else.
    expect(
      parse(
        JSON.stringify({
          insights: [
            {
              kind: 'theme',
              statement: 'Verifiable',
              detail: null,
              supportCount: 6,
              supportedBy: ['P1'],
            },
          ],
        })
      )
    ).not.toBeNull();
  });
});

describe('ordering and shape', () => {
  it('numbers the surviving findings from zero, in the model’s order', async () => {
    respondWith([
      {
        kind: 'tension',
        statement: 'First',
        detail: null,
        supportCount: 5,
        supportedBy: backedBy(5),
      },
      {
        kind: 'agreement',
        statement: 'Second',
        detail: 'more',
        supportCount: 4,
        supportedBy: backedBy(4),
      },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => [i.statement, i.ordinal])).toEqual([
      ['First', 0],
      ['Second', 1],
    ]);
  });

  it('renumbers contiguously after suppression — no gaps in the walkthrough', async () => {
    respondWith([
      {
        kind: 'tension',
        statement: 'Kept',
        detail: null,
        supportCount: 5,
        supportedBy: backedBy(5),
      },
      {
        kind: 'outlier',
        statement: 'Dropped',
        detail: null,
        supportCount: 1,
        supportedBy: backedBy(1),
      },
      {
        kind: 'theme',
        statement: 'Also kept',
        detail: null,
        supportCount: 4,
        supportedBy: backedBy(4),
      },
    ]);

    const result = await run(3);

    expect(result.insights.map((i) => i.ordinal)).toEqual([0, 1]);
  });

  it('normalises a blank detail to null', async () => {
    respondWith([
      {
        kind: 'agreement',
        statement: 'Something',
        detail: '   ',
        supportCount: 4,
        supportedBy: backedBy(4),
      },
    ]);
    expect((await run(3)).insights[0].detail).toBeNull();
  });

  it('reports the cost', async () => {
    respondWith([
      {
        kind: 'agreement',
        statement: 'X',
        detail: null,
        supportCount: 4,
        supportedBy: backedBy(4),
      },
    ]);
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

  it('asks for the backing labels, and says they are the one place labels may appear', async () => {
    respondWith([]);
    await run(3);
    const prompt = systemPrompt();
    expect(prompt).toMatch(/`supportedBy`/);
    expect(prompt).toMatch(/supportedBy` is the ONE place labels may appear/);
    expect(prompt).toContain('"supportedBy":string[]');
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

  it('does not describe an ordinary breakout as written by one person', async () => {
    respondWith([]);
    await run(3);
    expect(systemPrompt()).not.toMatch(/on behalf of/);
  });

  it('tells a scribe room’s model that one record stands for the whole room', async () => {
    // Without this the model reads a single written answer as one person, returns
    // `supportCount: 1`, and the gate suppresses every finding — the same failure the occupancy
    // basis exists to fix, just one layer further down.
    respondWith([]);
    await run(3, scribeMaterial(6));

    const prompt = systemPrompt();
    expect(prompt).toContain('6 people were in this room');
    expect(prompt).toMatch(/on behalf of all 6 people/);
    expect(prompt).toMatch(/held by all 6 of them/);
  });

  it('still tells a scribe room’s model to count dissent down, and to count honestly', async () => {
    respondWith([]);
    await run(3, scribeMaterial(6));

    const prompt = systemPrompt();
    expect(prompt).toMatch(/HONESTLY/);
    expect(prompt).toMatch(/dissent/i);
    expect(prompt).toMatch(/never count higher than 6/);
  });
});

describe('scribe rooms — occupancy is the support basis', () => {
  it('calls the model for a scribe room of six on ONE session', async () => {
    // The bug: `respondedCount` counts distinct sessions, a scribe room has exactly one by design,
    // so the floor check was permanently false and no scribe room could ever be synthesised.
    respondWith([
      {
        kind: 'agreement',
        statement: 'The deadline is the real problem',
        detail: null,
        supportCount: 6,
        supportedBy: ['P1'],
      },
    ]);

    const result = await run(3, scribeMaterial(6));

    expect(llmMock.runStructuredCompletion).toHaveBeenCalled();
    expect(result.insights.map((i) => i.statement)).toEqual(['The deadline is the real problem']);
  });

  it('never calls the model for a scribe room below the floor', async () => {
    respondWith([]);

    const result = await run(3, scribeMaterial(1));

    expect(llmMock.runStructuredCompletion).not.toHaveBeenCalled();
    expect(result).toEqual({ insights: [], withheld: 0, costUsd: 0 });
  });

  it('keeps the hard floor of two whatever the setting says', async () => {
    // A hand-edited `insightMinSupport` of 1 must not let a scribe room of one through. The floor
    // is structural; occupancy changed the unit being counted, not the bar.
    respondWith([]);

    await run(1, scribeMaterial(1));

    expect(llmMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('clamps a scribe finding to the ROOM SIZE, not to the one session', async () => {
    // The clamp keeps its full force here: a pen writing for four people cannot produce a finding
    // the facilitator reads out as "nine of you".
    respondWith([
      {
        kind: 'theme',
        statement: 'Everyone said scope',
        detail: null,
        supportCount: 9,
        supportedBy: ['P1'],
      },
    ]);

    const result = await run(3, scribeMaterial(4));

    expect(result.insights[0].supportCount).toBe(4);
  });

  it('still gates a scribe finding that the record itself shows was a minority', async () => {
    // Occupancy is the basis, but the gate is untouched: a model honestly reporting that only one
    // person in the room held a position must still have it suppressed.
    respondWith([
      {
        kind: 'agreement',
        statement: 'The room agreed on scope',
        detail: null,
        supportCount: 6,
        supportedBy: ['P1'],
      },
      {
        kind: 'outlier',
        statement: 'One of you dissented',
        detail: null,
        supportCount: 1,
        supportedBy: ['P1'],
      },
    ]);

    const result = await run(3, scribeMaterial(6));

    expect(result.insights.map((i) => i.statement)).toEqual(['The room agreed on scope']);
    expect(result.withheld).toBe(1);
  });

  it('does NOT count verified labels here — one pen still speaks for the whole room', async () => {
    // The trap this basis exists to avoid, re-laid by the verification fix: a scribe room has one
    // session by design, so its material carries exactly one label. Counting labels would report a
    // room of six as a room of one and suppress every scribe synthesis again. Under
    // `room-occupancy` the label GROUNDS the finding; occupancy is what counts it.
    respondWith([
      {
        kind: 'agreement',
        statement: 'The room settled on cutting scope',
        detail: null,
        supportCount: 6,
        supportedBy: ['P1'],
      },
    ]);

    const result = await run(3, scribeMaterial(6));

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].supportCount).toBe(6);
  });

  it('suppresses a scribe finding grounded in no label the record contains', async () => {
    // Occupancy supplies the count, but only once the finding is tied to the record it supposedly
    // came from. A fabricated citation is still worth nothing here.
    respondWith([
      {
        kind: 'theme',
        statement: 'Invented from nowhere',
        detail: null,
        supportCount: 6,
        supportedBy: ['P4'],
      },
    ]);

    const result = await run(3, scribeMaterial(6));

    expect(result.insights).toEqual([]);
    expect(result.withheld).toBe(1);
  });
});
