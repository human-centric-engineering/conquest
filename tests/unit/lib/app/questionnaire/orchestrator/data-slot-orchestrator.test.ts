/**
 * Unit tests for the data-slot-mode orchestrator (Data Slots feature).
 *
 * Pure, with stub invokers (no capability, no DB): the combined extraction merge, topic-local
 * data-slot targeting (linger in a theme, then transition), the late-stage question sweep, the
 * all-questions-answered offer gate, re-ask detection, and the data-slot fill side-effects.
 */

import { describe, expect, it } from 'vitest';

import {
  runDataSlotTurn,
  DATA_SLOT_SELECTION_TOOL_SLUG,
  OPENING_PROBE_TOOL_SLUG,
  PROVISIONAL_FLOOR_CONFIDENCE,
  type DataSlotTarget,
  type DataSlotAnsweredView,
  type OpeningRoutabilityOutcome,
  type TurnState,
} from '@/lib/app/questionnaire/orchestrator';
import type { DataSlotFillIntent } from '@/lib/app/questionnaire/extraction/types';
import { abuseAbortMessage } from '@/lib/app/questionnaire/seriousness';
import {
  state,
  stubInvokers,
  intent,
  finding,
  decision,
  q,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

function ds(over: Partial<DataSlotTarget> & { id: string; theme: string }): DataSlotTarget {
  return {
    id: over.id,
    key: over.key ?? over.id,
    name: over.name ?? `Slot ${over.id}`,
    description: over.description ?? 'desc',
    theme: over.theme,
    ordinal: over.ordinal ?? 0,
    weight: over.weight ?? 1,
    ...(over.mappedQuestionKeys ? { mappedQuestionKeys: over.mappedQuestionKeys } : {}),
  };
}

/** A data-slot-mode TurnState: base state + data slots / fills / active slot / re-ask counts. */
function dsState(input: {
  userMessage?: string;
  questions: TurnState['questions'];
  answered?: TurnState['answered'];
  dataSlots: DataSlotTarget[];
  dataSlotAnswered?: DataSlotAnsweredView[];
  activeDataSlotKey?: string | null;
  dataSlotAttempts?: Record<string, number>;
  existingAnswers?: TurnState['existingAnswers'];
  selectionRound?: number;
  config?: Partial<TurnState['config']>;
  /** Sectioned interviews (P21): the active section's targeting pools and its labels. */
  sectionQuestions?: TurnState['sectionQuestions'];
  sectionDataSlots?: TurnState['sectionDataSlots'];
  sectionMeta?: TurnState['sectionMeta'];
  /** F17.36 phase 4: data-slot keys of topics seated during the opening. */
  bridgeDataSlotKeys?: string[];
}): TurnState {
  return {
    ...state({
      userMessage: input.userMessage ?? 'hi',
      questions: input.questions,
      answered: input.answered ?? [],
      ...(input.existingAnswers ? { existingAnswers: input.existingAnswers } : {}),
      ...(input.selectionRound !== undefined ? { selectionRound: input.selectionRound } : {}),
      ...(input.config ? { config: input.config } : {}),
    }),
    dataSlots: input.dataSlots,
    dataSlotAnswered: input.dataSlotAnswered ?? [],
    activeDataSlotKey: input.activeDataSlotKey ?? null,
    ...(input.dataSlotAttempts ? { dataSlotAttempts: input.dataSlotAttempts } : {}),
    ...(input.sectionQuestions !== undefined ? { sectionQuestions: input.sectionQuestions } : {}),
    ...(input.sectionDataSlots !== undefined ? { sectionDataSlots: input.sectionDataSlots } : {}),
    ...(input.sectionMeta !== undefined ? { sectionMeta: input.sectionMeta } : {}),
    ...(input.bridgeDataSlotKeys !== undefined
      ? { bridgeDataSlotKeys: input.bridgeDataSlotKeys }
      : {}),
  };
}

const fill = (
  key: string,
  confidence = 0.9,
  provenance: DataSlotFillIntent['provenance'] = 'direct'
): DataSlotFillIntent => ({
  dataSlotKey: key,
  value: 'pos',
  paraphrase: `paraphrase for ${key}`,
  confidence,
  provenance,
});

describe('runDataSlotTurn — targeting', () => {
  it('targets the first unfilled data slot on the opening turn', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        userMessage: '',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
      expect(result.response.isTransition).toBe(false);
    }
  });

  it('lingers in the current theme (topic-local) before moving on', async () => {
    const { invokers } = stubInvokers();
    // d1 (theme A) was just asked + filled; d2 (theme A) and d3 (theme B) remain → pick d2 (same theme).
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', theme: 'A', ordinal: 0 }),
          ds({ id: 'd2', theme: 'A', ordinal: 1 }),
          ds({ id: 'd3', theme: 'B', ordinal: 2 }),
        ],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d2');
      expect(result.response.isTransition).toBe(false); // still theme A
    }
  });

  it('transitions to the next theme once the current area is exhausted (isTransition)', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd3', theme: 'B' })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d3');
      expect(result.response.isTransition).toBe(true); // A → B
    }
  });

  it('flags a re-ask when the active slot is still unfilled', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        dataSlotAnswered: [],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
      expect(result.response.isReask).toBe(true);
    }
  });
});

describe('runDataSlotTurn — adaptive selection (selectDataSlot invoker)', () => {
  it('targets the slot the adaptive selector chooses, over the deterministic topic-local pick', async () => {
    // Deterministic would linger in theme A (d2); the selector instead bridges to d3 (theme B).
    const invokers = {
      ...stubInvokers().invokers,
      async selectDataSlot() {
        return { dataSlotKey: 'd3', rationale: 'flows naturally', costUsd: 0.002 };
      },
    };
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A', ordinal: 0 }),
          ds({ id: 'd2', key: 'd2', theme: 'A', ordinal: 1 }),
          ds({ id: 'd3', key: 'd3', theme: 'B', ordinal: 2 }),
        ],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotKey).toBe('d3');
      expect(result.response.isTransition).toBe(true); // A → B
    }
    // The selector's spend is folded into the turn cost.
    expect(result.costUsd).toBeCloseTo(0.002);
  });

  it('falls back to the deterministic pick when the selector returns null', async () => {
    const invokers = {
      ...stubInvokers().invokers,
      async selectDataSlot() {
        return null;
      },
    };
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A', ordinal: 0 }),
          ds({ id: 'd2', key: 'd2', theme: 'A', ordinal: 1 }),
        ],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    // Deterministic topic-local pick → same theme A, slot d2.
    expect(result.response.kind === 'data_slot' && result.response.dataSlotId).toBe('d2');
  });

  it('ignores an off-pool selector pick and falls back to the deterministic order', async () => {
    const invokers = {
      ...stubInvokers().invokers,
      async selectDataSlot() {
        return { dataSlotKey: 'nope', rationale: 'hallucinated', costUsd: 0.001 };
      },
    };
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
      }),
      invokers
    );
    // Off-pool 'nope' is rejected → first unfilled (d1).
    expect(result.response.kind === 'data_slot' && result.response.dataSlotId).toBe('d1');
  });
});

describe('runDataSlotTurn — sweep + completion', () => {
  it('sweeps an unanswered question once every data slot is filled', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1', prompt: 'Leftover?' }), q({ id: 'q2' })],
        answered: [{ questionId: 'q2', confidence: 0.9 }], // q1 still open
        dataSlots: [ds({ id: 'd1', theme: 'A' })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
      }),
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind === 'question') {
      expect(result.response.questionId).toBe('q1');
      expect(result.response.text).toBe('Leftover?');
    }
    expect(result.targetedQuestionId).toBe('q1');
  });

  it('offers to submit only when ALL questions are answered', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        answered: [{ questionId: 'q1', confidence: 0.9 }],
        dataSlots: [ds({ id: 'd1', theme: 'A' })],
        dataSlotAnswered: [],
      }),
      invokers
    );
    expect(result.response.kind).toBe('offer');
    expect(result.assessment.kind).toBe('offer');
  });

  it('includes costWrapUp in the offer input when soft cost pressure is active', async () => {
    // When state.costPressure === 'soft' and all questions are answered, buildOfferInput adds
    // costWrapUp: true to the OfferComposeInput so the prose composer can hint the user to wrap up.
    // dsState() does not forward costPressure, so we spread it on after construction.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      {
        ...dsState({
          questions: [q({ id: 'q1' })],
          answered: [{ questionId: 'q1', confidence: 0.9 }],
          dataSlots: [ds({ id: 'd1', theme: 'A' })],
          dataSlotAnswered: [],
        }),
        costPressure: 'soft' as const,
      },
      invokers
    );
    expect(result.response.kind).toBe('offer');
    if (result.response.kind === 'offer') {
      expect(result.response.input.costWrapUp).toBe(true);
    }
  });
});

describe('runDataSlotTurn — balanced required-question interleaving', () => {
  it('interleaves a required question directly when question coverage lags data-slot coverage', async () => {
    // 2 of 3 data slots filled (data coverage ≈ 0.67) but the required question is unanswered
    // (question coverage 0) → the lag exceeds the threshold, so surface the required question now
    // rather than deepening into the last data slot or waiting for the end-of-run sweep.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'qReq', required: true, prompt: 'Required one?' })],
        answered: [],
        dataSlots: [
          ds({ id: 'd1', theme: 'A' }),
          ds({ id: 'd2', theme: 'A' }),
          ds({ id: 'd3', theme: 'A' }),
        ],
        dataSlotAnswered: [
          { dataSlotId: 'd1', confidence: 0.9 },
          { dataSlotId: 'd2', confidence: 0.9 },
        ],
        activeDataSlotKey: 'd2',
      }),
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind === 'question') {
      expect(result.response.questionId).toBe('qReq');
      expect(result.response.text).toBe('Required one?');
    }
    expect(result.targetedQuestionId).toBe('qReq');
  });

  it('keeps targeting data slots when question coverage keeps pace (no early required ask)', async () => {
    // The required question is unanswered, but background question coverage (0.8) is ahead of
    // data-slot coverage (0.5) — no lag — so the conversation stays in the data-slot flow.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [
          q({ id: 'qReq', required: true }),
          q({ id: 'qA' }),
          q({ id: 'qB' }),
          q({ id: 'qC' }),
          q({ id: 'qD' }),
        ],
        answered: [
          { questionId: 'qA', confidence: 0.9 },
          { questionId: 'qB', confidence: 0.9 },
          { questionId: 'qC', confidence: 0.9 },
          { questionId: 'qD', confidence: 0.9 },
        ],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'A' })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d2');
    }
  });

  it('sweeps the required question before an optional one once data slots are filled', async () => {
    // End-of-run sweep is required-first: even though the optional question sorts earlier, the
    // mandatory one is asked first.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [
          q({ id: 'qOpt', ordinal: 0, prompt: 'Optional?' }),
          q({ id: 'qReq', ordinal: 1, required: true, prompt: 'Required?' }),
        ],
        answered: [],
        dataSlots: [ds({ id: 'd1', theme: 'A' })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
      }),
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind === 'question') {
      expect(result.response.questionId).toBe('qReq');
      expect(result.response.text).toBe('Required?');
    }
  });

  it('opens on a data slot even when a required question is unanswered', async () => {
    // The opening turn (no message yet → no coverage, no lag) must start conversationally with a
    // data slot, not jump straight to a required question.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        userMessage: '',
        questions: [q({ id: 'qReq', required: true })],
        answered: [],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
        dataSlotAnswered: [],
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
    }
  });
});

describe('runDataSlotTurn — side effects', () => {
  it('merges this turn’s fills + carries them as side effects, and answers questions in the background', async () => {
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'q1' })], dataSlotFills: [fill('d1')] },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1', key: 'q1' }), q({ id: 'q2', key: 'q2' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'A' })],
      }),
      invokers
    );
    // Background question intent surfaced for persistence…
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
    // …and the data-slot fill carried for persistence.
    expect(result.sideEffects.dataSlotFills).toEqual([fill('d1')]);
    // d1 is now filled this turn → targeting moves on to d2.
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
    // The selection step was recorded.
    expect(result.toolCalls.map((c) => c.slug)).toContain(DATA_SLOT_SELECTION_TOOL_SLUG);
  });
});

describe('runDataSlotTurn — seriousness / abuse gate', () => {
  it('disregards a non-serious answer (both answers and data-slot fills), strikes, and warns', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], dataSlotFills: [fill('d1')] },
      serious: { verdict: { serious: false, reason: 'hostile' } },
    });

    const result = await runDataSlotTurn(
      dsState({
        userMessage: '543 years', // preposterous, not keyword-abuse → exercises the LLM judge path
        questions: [q({ id: 'a' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
      }),
      invokers
    );

    expect(calls.serious).toHaveLength(1);
    // Neither the question answer nor the data-slot fill is kept.
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
    expect(result.sideEffects.dataSlotFills).toHaveLength(0);
    expect(result.abuse).toMatchObject({ flagged: true, abandon: false, newStrikeCount: 1 });
    expect(result.events.some((e) => e.type === 'warning' && e.code === 'seriousness')).toBe(true);
  });

  it('abandons the session on the threshold strike', async () => {
    const { invokers } = stubInvokers({
      // Extraction also fails this turn → it would push a "couldn't capture" diagnostic notice;
      // on a terminal abandon turn that side-band must be dropped (only the final message shows).
      extract: { intents: [], dataSlotFills: [fill('d1')], diagnostic: 'extraction_failed' },
      serious: { verdict: { serious: false, reason: 'hostile' } },
    });

    const result = await runDataSlotTurn(
      {
        ...dsState({
          userMessage: 'screw you',
          questions: [q({ id: 'a' })],
          dataSlots: [ds({ id: 'd1', theme: 'A' })],
        }),
        abuseStrikes: 3, // the next strike is the 4th → abandon
      },
      invokers
    );

    expect(result.abuse).toMatchObject({ flagged: true, abandon: true, newStrikeCount: 4 });
    expect(result.response).toEqual({ kind: 'complete', text: abuseAbortMessage(4) });
    expect(result.sideEffects.dataSlotFills).toHaveLength(0);
    // No side-band notices on the terminal turn (the extraction diagnostic is dropped).
    expect(result.events).toEqual([]);
  });

  it('does not run the judge when abuseThreshold is 0 (off for this questionnaire)', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], dataSlotFills: [fill('d1')] },
      serious: { verdict: { serious: false, reason: 'hostile' } },
    });

    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'screw you',
        questions: [q({ id: 'a' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        config: { abuseThreshold: 0 },
      }),
      invokers
    );

    // Gate off → no judge, no strike; the answer + fill are kept.
    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
    expect(result.sideEffects.dataSlotFills).toHaveLength(1);
  });
});

describe('runDataSlotTurn — move on / provisional park', () => {
  it('parks the active slot at the attempts cap, marks the fill provisional, and bridges to a new theme', async () => {
    // d1 (theme A) was asked twice and only weakly answered again this turn; d2 (theme B) is open.
    // A weak answer is `inferred`, not stated — only such a fill is parkable. A `direct` fill is
    // covered regardless of its confidence number and is never parked (see the direct-covered tests).
    const { invokers } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.3, 'inferred')] },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2 },
      }),
      invokers
    );
    // The weak fill for d1 is recorded as provisional so we can move on.
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    expect(d1Fill?.provisional).toBe(true);
    // …and the conversation bridges to the other theme rather than re-asking d1.
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d2');
      expect(result.response.isTransition).toBe(true);
      expect(result.response.isReask).toBe(false);
    }
  });

  it('synthesises a floor provisional fill when the extractor returns nothing for the parked slot', async () => {
    const { invokers } = stubInvokers({ extract: { dataSlotFills: [] } });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2 },
      }),
      invokers
    );
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    expect(d1Fill).toBeDefined();
    expect(d1Fill?.provisional).toBe(true);
    expect(d1Fill?.confidence).toBe(PROVISIONAL_FLOOR_CONFIDENCE);
    expect(d1Fill?.provenance).toBe('inferred');
  });

  it('does not re-target a slot parked on a prior turn (a provisional fill counts as covered)', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        // d1 was parked earlier (provisional, low confidence); d2 is still open.
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.2, provisional: true }],
        activeDataSlotKey: null,
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
  });

  it('keeps a later confident answer non-provisional (promotes a parked slot)', async () => {
    // d1 was parked (provisional); this turn the respondent finally answers it clearly.
    const { invokers } = stubInvokers({ extract: { dataSlotFills: [fill('d1', 0.95)] } });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.2, provisional: true }],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2 },
      }),
      invokers
    );
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    // The confident fill is NOT re-marked provisional — persistence then clears the flag (promotion).
    expect(d1Fill?.confidence).toBe(0.95);
    expect(d1Fill?.provisional).not.toBe(true);
  });

  it('parks after a single ask when maxDataSlotAttempts is 1', async () => {
    // A weak answer is `inferred`, not stated — only such a fill is parkable. A `direct` fill is
    // covered regardless of its confidence number and is never parked (see the direct-covered tests).
    const { invokers } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.3, 'inferred')] },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 1 },
        config: { maxDataSlotAttempts: 1 },
      }),
      invokers
    );
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    expect(d1Fill?.provisional).toBe(true);
  });

  it('falls through to the parked theme when it is the only remaining theme', async () => {
    // avoidTheme is set to the just-parked slot's theme (A). pickNextDataSlot first looks for a
    // slot in a DIFFERENT theme; finding none it falls through and still picks from theme A.
    // This ensures the conversation never stalls when all remaining slots share the parked theme.
    // A weak answer is `inferred`, not stated — only such a fill is parkable. A `direct` fill is
    // covered regardless of its confidence number and is never parked (see the direct-covered tests).
    const { invokers } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.3, 'inferred')] },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'A' }), // only remaining slot, same theme as parked
        ],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2 },
      }),
      invokers
    );
    // d2 is picked even though it shares the parked theme (no alternative theme available).
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d2');
    }
  });

  it('never parks (or keeps any fill) on a disregarded non-genuine turn, even at the cap', async () => {
    const { invokers } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.3)] },
      serious: { verdict: { serious: false, reason: 'gibberish' } },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2, abuseThreshold: 4 },
      }),
      invokers
    );
    // The seriousness gate cleared the fills first — nothing (provisional or otherwise) is kept.
    expect(result.sideEffects.dataSlotFills).toHaveLength(0);
  });
});

describe('runDataSlotTurn — a stated (direct) answer is covered regardless of confidence', () => {
  it('treats a direct fill below the confidence threshold as covered — moves on, does not re-ask', async () => {
    // The respondent plainly STATED their position ("extremely unlikely"), but the extractor
    // under-scored it at 0.4 (< the 0.5 fill threshold). A `direct` fill is covered on its
    // provenance, so targeting moves to the next slot instead of re-asking the one they answered.
    const { invokers } = stubInvokers({ extract: { dataSlotFills: [fill('d1', 0.4, 'direct')] } });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        activeDataSlotKey: 'd1',
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d2');
      expect(result.response.isReask).toBe(false);
    }
  });

  it('never parks a slot answered directly this turn, even at the attempts cap (the regression)', async () => {
    // The exact screenshot bug: the slot hit the re-ask cap, and this turn the respondent FINALLY
    // answered it clearly ("extremely unlikely") — but the extractor under-scored it at 0.4. Before
    // the fix this parked the clear answer as `provisional · may revisit`. A direct fill must never
    // be parked: it stays a real, non-provisional answer.
    const { invokers } = stubInvokers({ extract: { dataSlotFills: [fill('d1', 0.4, 'direct')] } });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: 2 },
        config: { maxDataSlotAttempts: 2 },
      }),
      invokers
    );
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    expect(d1Fill?.provisional).not.toBe(true);
    // d1 is covered → the loop does not re-ask it; with q1 still open it sweeps the question directly.
    expect(result.response.kind).toBe('question');
    if (result.response.kind === 'question') expect(result.response.questionId).toBe('q1');
  });

  it('keeps a prior-turn direct fill covered even when its loaded confidence is below the threshold', async () => {
    // Cross-turn: d1 was answered directly last turn but persisted at 0.4 confidence. The loader
    // threads provenance, so this turn it is still covered (not re-asked) and targeting picks d2.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        userMessage: '',
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.4, provenance: 'direct' }],
        activeDataSlotKey: null,
      }),
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
  });
});

describe('runDataSlotTurn — contradiction detection + refinement (parity with question mode)', () => {
  /** Two background question answers so the ≥2-answers floor is met. */
  const twoAnswers = [
    { slotKey: 'satisfaction', value: 1, provenance: 'inferred' as const, confidence: 0.8 },
    { slotKey: 'recommend', value: 0, provenance: 'inferred' as const, confidence: 0.8 },
  ];

  it('runs the detector under flag mode and surfaces a contradiction warning', async () => {
    const { invokers, calls } = stubInvokers({
      detect: {
        findings: [finding({ slotKeys: ['satisfaction'], explanation: 'now loves the job' })],
      },
    });
    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'no obstacles, i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        existingAnswers: twoAnswers,
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(1);
    expect(result.contradictions).toHaveLength(1);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'now loves the job',
      })
    );
  });

  it('probe mode DEFERS: asks a reconciliation question, suppresses writes, parks the finding, no refine', async () => {
    const { invokers, calls } = stubInvokers({
      detect: {
        findings: [
          finding({
            slotKeys: ['satisfaction'],
            explanation: 'Said they hate the job, now love it.',
            suggestedProbe: 'Earlier this felt different — what changed?',
          }),
        ],
      },
      // extraction captured a fill this turn — it must be suppressed (nothing recorded until confirm).
      extract: {
        intents: [intent({ slotKey: 'satisfaction', value: 5 })],
        dataSlotFills: [fill('d1')],
      },
    });
    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'no obstacles, i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: twoAnswers,
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
      }),
      invokers
    );
    // The reconciliation question is ASKED (not buried in the box), with the consequence stated.
    expect(result.response.kind).toBe('contradiction_probe');
    if (result.response.kind === 'contradiction_probe') {
      expect(result.response.text).toContain('Earlier this felt different — what changed?');
      expect(result.response.text.toLowerCase()).toContain('update your earlier answer');
      expect(result.response.slotKeys).toEqual(['satisfaction']);
    }
    // The blue notice is informational — the EXPLANATION, never the question.
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'Said they hate the job, now love it.',
      })
    );
    // Nothing is recorded this turn, and no refinement runs (it defers to the confirmation turn).
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
    expect(result.sideEffects.dataSlotFills).toHaveLength(0);
    expect(calls.refine).toHaveLength(0);
    expect(result.sideEffects.answerRefinements).toHaveLength(0);
    // The finding is parked for the next turn to resolve.
    expect(result.sideEffects.pendingContradiction).toMatchObject({
      slotKeys: ['satisfaction'],
      statement: 'no obstacles, i love my job',
    });
  });

  it('resolution turn: a parked pending contradiction runs the refiner and clears the pending state', async () => {
    const { invokers, calls } = stubInvokers({
      refine: { decisions: [decision({ slotKey: 'satisfaction', newValue: 5 })] },
      // A fresh detect stub that would fire if (wrongly) re-detected — it must NOT be called.
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
    });
    const result = await runDataSlotTurn(
      {
        ...dsState({
          userMessage: 'yes, I love it now',
          questions: [q({ id: 'q1', key: 'satisfaction' })],
          dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
          existingAnswers: twoAnswers,
          config: { contradictionMode: 'probe', contradictionWindowN: 1 },
        }),
        pendingContradiction: {
          slotKeys: ['satisfaction'],
          explanation: 'hate vs love',
          statement: 'i love my job',
          raisedAtTurnIndex: 1,
        },
      },
      invokers
    );
    // Resolution runs the refiner (not fresh detection) and applies the change.
    expect(calls.refine).toHaveLength(1);
    expect(calls.detect).toHaveLength(0);
    expect(result.sideEffects.answerRefinements).toHaveLength(1);
    // Pending is cleared (null = clear).
    expect(result.sideEffects.pendingContradiction).toBeNull();
    // The turn proceeds normally to the next target (not a probe).
    expect(result.response.kind).not.toBe('contradiction_probe');
  });

  it('asks about the conflict instead of refining it — parity with question mode', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
      refine: { decisions: [decision({ slotKey: 'satisfaction', newValue: 5 })] },
    });
    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: twoAnswers,
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
      }),
      invokers
    );
    // Deferred: nothing rewritten this turn, and the respondent is asked which answer stands.
    expect(calls.refine).toHaveLength(0);
    expect(result.sideEffects.answerRefinements).toHaveLength(0);
    expect(result.response.kind).toBe('contradiction_probe');
    expect(result.sideEffects.pendingContradiction).toMatchObject({ slotKeys: ['satisfaction'] });
  });

  it('does not run the detector when contradictionMode is off (the default)', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
    });
    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: twoAnswers,
        // config omitted → DEFAULT contradictionMode is 'off'
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('detects with a single stored answer + a message (reversal against the latest message)', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
    });
    await runDataSlotTurn(
      dsState({
        userMessage: 'i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: [twoAnswers[0]], // a single prior answer — enough, given the latest message
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(1);
  });

  it('checks a tap-to-answer turn in data-slot mode too (parity with question mode)', async () => {
    // No message, but an answer arrived through its answer control. The detector compares the stored
    // background answers against each other, so the floor is two.
    const { invokers, calls } = stubInvokers({
      detect: { findings: [] },
    });
    await runDataSlotTurn(
      {
        ...dsState({
          userMessage: '',
          questions: [q({ id: 'q1', key: 'satisfaction' })],
          dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
          existingAnswers: twoAnswers,
          config: { contradictionMode: 'probe', contradictionWindowN: 4 },
        }),
        answeredQuestionKey: 'satisfaction',
      },
      invokers
    );
    expect(calls.detect).toHaveLength(1);
  });

  it('skips detection with no stored answers (nothing to contradict yet)', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
    });
    await runDataSlotTurn(
      dsState({
        userMessage: 'i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: [],
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
  });

  it('does not run the detector on the contradiction off-cadence turn', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['satisfaction'] })] },
    });
    await runDataSlotTurn(
      dsState({
        userMessage: 'i love my job',
        questions: [q({ id: 'q1', key: 'satisfaction' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A' })],
        existingAnswers: twoAnswers,
        selectionRound: 1, // every_n_turns=2 → run on 0,2,4… not turn 1
        config: {
          contradictionMode: 'probe',
          contradictionWindowN: 1,
          contradictionEveryNTurns: 2,
        },
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
  });
});

describe('runDataSlotTurn — deepen a volunteered tangent', () => {
  it('re-surfaces a just-captured non-active topic so the selector can go deeper (framed as a re-ask)', async () => {
    const { invokers, calls } = stubInvokers({
      // The respondent volunteered a strong opinion on d_be (Business Execution) while we were
      // exploring Strategy — a direct fill on a NON-active slot, which covers it immediately.
      extract: { dataSlotFills: [fill('d_be', 0.8, 'direct')] },
      // The adaptive selector chooses the deepen candidate.
      selectDataSlot: {
        dataSlotKey: 'd_be',
        rationale: 'follow the KPIs they raised',
        costUsd: 0.002,
      },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd_strat', theme: 'Strategy', ordinal: 0 }),
          ds({ id: 'd_strat2', theme: 'Strategy', ordinal: 1 }),
          ds({ id: 'd_be', theme: 'Business Execution', ordinal: 2 }),
        ],
        activeDataSlotKey: 'd_strat',
      }),
      invokers
    );
    // The covered, just-volunteered slot was offered to the selector even though it is not "unfilled".
    const pool = calls.selectData[0]?.unfilled.map((s) => s.id) ?? [];
    expect(pool).toContain('d_be');
    // …and the pick is framed as a follow-up (re-ask), not a fresh transition into a new area.
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d_be');
      expect(result.response.isReask).toBe(true);
      expect(result.response.isTransition).toBe(false);
    }
  });

  it('does not re-offer a volunteered slot once it is the active slot (deepen once, then move on)', async () => {
    const { invokers, calls } = stubInvokers({
      // d_be is now the ACTIVE slot (we deepened it last turn) and is re-filled this turn.
      extract: { dataSlotFills: [fill('d_be', 0.8, 'direct')] },
      selectDataSlot: { dataSlotKey: 'd_strat', rationale: 'move on', costUsd: 0.001 },
    });
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd_strat', theme: 'Strategy', ordinal: 0 }),
          ds({ id: 'd_be', theme: 'Business Execution', ordinal: 1 }),
        ],
        activeDataSlotKey: 'd_be',
      }),
      invokers
    );
    // d_be is active → excluded from the deepen set → not re-surfaced; pool is just the unfilled set.
    const pool = calls.selectData[0]?.unfilled.map((s) => s.id) ?? [];
    expect(pool).not.toContain('d_be');
    expect(pool).toContain('d_strat');
    expect(result.response.kind).toBe('data_slot');
  });

  it('does not deepen an INFERRED (non-direct) volunteered fill — only strong, stated opinions', async () => {
    const { invokers, calls } = stubInvokers({
      // A covered-but-INFERRED fill on a non-active slot is not a strong, stated volunteer — it is
      // captured-and-done (covered by confidence) and must NOT be re-surfaced for deepening.
      extract: { dataSlotFills: [fill('d_be', 0.9, 'inferred')] },
      selectDataSlot: { dataSlotKey: 'd_strat', rationale: 'continue', costUsd: 0.001 },
    });
    await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd_strat', theme: 'Strategy', ordinal: 0 }),
          ds({ id: 'd_be', theme: 'Business Execution', ordinal: 1 }),
        ],
        activeDataSlotKey: 'd_strat',
      }),
      invokers
    );
    const pool = calls.selectData[0]?.unfilled.map((s) => s.id) ?? [];
    expect(pool).not.toContain('d_be');
  });
});

// ─── Completeness milestones ──────────────────────────────────────────────────
//
// Regression guard: milestones were originally wired into `runTurn` only, so they silently never
// fired on THIS pipeline — which is the one every version with data slots takes, i.e. in practice
// the whole feature was a no-op. Both pipelines now delegate to the same `resolveMilestoneCrossing`.

describe('runDataSlotTurn — completeness milestones (F-progress)', () => {
  /** 4 questions, 2 answered → data-slot coverage 0.5 (50%). */
  const halfway = (config: Partial<TurnState['config']> = {}) =>
    dsState({
      userMessage: 'an answer',
      questions: [
        q({ id: 'a', key: 'a' }),
        q({ id: 'b', key: 'b' }),
        q({ id: 'c', key: 'c' }),
        q({ id: 'd', key: 'd' }),
      ],
      answered: [
        { questionId: 'a', confidence: 1 },
        { questionId: 'b', confidence: 1 },
      ],
      dataSlots: [ds({ id: 'd1', theme: 'work', key: 'k1' })],
      config: { milestoneBannerThresholds: [25, 50, 75], ...config },
    });

  it('fires the milestone banner on the data-slot pipeline too', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(halfway(), invokers);

    const milestones = result.events.filter(
      (e): e is Extract<typeof e, { type: 'warning' }> =>
        e.type === 'warning' && e.code === 'milestone'
    );
    expect(milestones.map((e) => e.message)).toEqual(["You're 50% of the way through."]);
    expect(result.sideEffects.raisedMilestones).toEqual([25, 50]);
  });

  it('respects the session ledger, so a resumed data-slot session does not repeat a banner', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn({ ...halfway(), raisedMilestones: [25, 50] }, invokers);

    expect(result.events.some((e) => e.type === 'warning' && e.code === 'milestone')).toBe(false);
    expect(result.sideEffects.raisedMilestones).toBeUndefined();
  });

  it('fires nothing when the version turned milestone banners off', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(halfway({ milestoneBannerEnabled: false }), invokers);

    expect(result.events.some((e) => e.type === 'warning' && e.code === 'milestone')).toBe(false);
    expect(result.sideEffects.raisedMilestones).toBeUndefined();
  });

  it('announces and banks nothing on a contradiction-probe turn, so the milestone survives', async () => {
    // Same rule as `runTurn`, and it has to hold on BOTH pipelines or the guard is only half there.
    // A probe turn's merged intents are never persisted — the conflicting answer is re-asked — so
    // banking a threshold off them would permanently cost the respondent that milestone.
    const { invokers } = stubInvokers({
      detect: {
        findings: [
          finding({
            slotKeys: ['a'],
            explanation: 'Said A then not-A.',
            suggestedProbe: 'Which of those is right?',
          }),
        ],
      },
    });
    const result = await runDataSlotTurn(
      {
        ...halfway({ contradictionMode: 'probe', contradictionWindowN: 1 }),
        existingAnswers: [
          { slotKey: 'a', value: 1, provenance: 'direct' as const },
          { slotKey: 'b', value: 2, provenance: 'direct' as const },
        ],
      },
      invokers
    );

    // Guard the premise: without this the test would pass for the wrong reason (no probe at all).
    expect(result.response.kind).toBe('contradiction_probe');
    expect(result.events.some((e) => e.type === 'warning' && e.code === 'milestone')).toBe(false);
    expect(result.sideEffects.raisedMilestones).toBeUndefined();
  });
});

/**
 * The opening's follow-up allowance (G03 / F17.17).
 *
 * The mechanism under test is deliberately small: the allowance only ever LOWERS the per-slot
 * re-ask cap for a slot in the opening, so a probe the opening cannot afford becomes an ordinary
 * park. What matters is that it does that in exactly the right circumstances and in no others.
 */
describe('runDataSlotTurn — the opening probe allowance (G03)', () => {
  /** A weak answer on d1 — `inferred`, so it is parkable — with a per-slot cap of 3. */
  function weakOpening(input: {
    openingProbe?: TurnState['openingProbe'];
    openingRoutability?: Partial<OpeningRoutabilityOutcome>;
    attempts?: number;
    /** The author's per-slot re-ask cap. Deliberately above 1 so a follow-up is possible at all. */
    cap?: number;
  }) {
    const { invokers, calls } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.3, 'inferred')] },
      ...('openingRoutability' in input
        ? { openingRoutability: input.openingRoutability ?? {} }
        : {}),
    });
    const state = {
      ...dsState({
        questions: [q({ id: 'q1' })],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'A' }),
          ds({ id: 'd2', key: 'd2', theme: 'B' }),
        ],
        activeDataSlotKey: 'd1',
        dataSlotAttempts: { d1: input.attempts ?? 1 },
        config: { maxDataSlotAttempts: input.cap ?? 3 },
      }),
      ...(input.openingProbe ? { openingProbe: input.openingProbe } : {}),
    };
    return { state, invokers, calls };
  }

  it('re-asks as before when no allowance governs the turn', async () => {
    const { state, invokers } = weakOpening({});
    const result = await runDataSlotTurn(state, invokers);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
      expect(result.response.isReask).toBe(true);
    }
  });

  it('parks instead of following up once the opening has spent its allowance', async () => {
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 1, allowance: 1 },
      openingRoutability: { routable: false },
    });
    const result = await runDataSlotTurn(state, invokers);
    const d1Fill = (result.sideEffects.dataSlotFills ?? []).find((f) => f.dataSlotKey === 'd1');
    expect(d1Fill?.provisional).toBe(true);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
    // Spent means spent: there is nothing to decide, so nothing is paid to decide it.
    expect(calls.routability).toHaveLength(0);
  });

  it('withholds an affordable follow-up when what they said is already routable', async () => {
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 1 },
      // The live invoker always measures itself, so the recorded latency is the production path.
      openingRoutability: {
        routable: true,
        reason: 'They named a section outright.',
        latencyMs: 42,
      },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(calls.routability).toHaveLength(1);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
    // Recorded on the turn, not only in a log — a withheld question should be answerable for, and
    // the latency is what makes a check that quietly got slow visible at all.
    expect(result.toolCalls).toContainEqual(
      expect.objectContaining({ slug: OPENING_PROBE_TOOL_SLUG, success: true, latencyMs: 42 })
    );
  });

  it('spends the follow-up when no check is wired at all', async () => {
    // Reachable in production: `openingProbe` is resolved whenever the allowance governs an opening
    // slot, but the route only wires the check when the version HAS conditional topics — with none,
    // there is nothing to be routable against and the invoker is omitted entirely. The turn must
    // then behave exactly as it did before G03 rather than silently withholding the question.
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 1 },
    });
    expect(invokers.assessOpeningRoutability).toBeUndefined();

    const result = await runDataSlotTurn(state, invokers);

    expect(calls.routability).toHaveLength(0);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
      expect(result.response.isReask).toBe(true);
    }
    // No check ran, so there is nothing to record — an empty verdict must not fake a tool call.
    expect(result.toolCalls.some((t) => t.slug === OPENING_PROBE_TOOL_SLUG)).toBe(false);
  });

  it('spends the follow-up when the answer is too abstract to route on', async () => {
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 1 },
      openingRoutability: { routable: false, reason: 'A slogan, not a situation.' },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(calls.routability).toHaveLength(1);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') {
      expect(result.response.dataSlotId).toBe('d1');
      expect(result.response.isReask).toBe(true);
    }
  });

  it('spends the follow-up when the check could not be made at all', async () => {
    // `routable: null` is the absence of a verdict, not a verdict of "routable". The check may only
    // ever save a question — never skip one on the strength of a call that did not happen.
    const { state, invokers } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 1 },
      openingRoutability: { routable: null, diagnostic: 'routability_unavailable' },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d1');
  });

  it('leaves a slot outside the opening alone', async () => {
    // The allowance governs the opening. A core-topic slot asked before the plan is decided is not
    // part of it, and must not be rationed by it.
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d_other'], spent: 1, allowance: 1 },
      openingRoutability: { routable: true },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(calls.routability).toHaveLength(0);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d1');
  });

  it('spends every probe an allowance of three actually promises', async () => {
    // The allowance is a COUNT of follow-ups, so an author who sets three must get three. Walk the
    // real sequence on one slot: each turn the interview re-asks, `spent` grows by one and
    // `attempts` grows by one, and the loader recomputes `remaining` from the turn record. The trap
    // is counting the allowance down twice — once through `spent` and again through the cap — which
    // parks a turn early and quietly delivers N-1 probes for an author who asked for N.
    const asks: string[] = [];
    for (let probe = 0; probe < 3; probe += 1) {
      const turn = weakOpening({
        attempts: probe + 1,
        cap: 4,
        openingProbe: { slotIds: ['d1'], spent: probe, allowance: 3 },
        openingRoutability: { routable: false },
      });
      const result = await runDataSlotTurn(turn.state, turn.invokers);
      if (result.response.kind === 'data_slot') asks.push(result.response.dataSlotId);
    }
    // Three follow-ups asked, none of them a premature move-on to d2.
    expect(asks).toEqual(['d1', 'd1', 'd1']);

    // And the fourth turn — the allowance now genuinely spent — parks.
    const exhausted = weakOpening({
      attempts: 4,
      cap: 4,
      openingProbe: { slotIds: ['d1'], spent: 3, allowance: 3 },
      openingRoutability: { routable: false },
    });
    const after = await runDataSlotTurn(exhausted.state, exhausted.invokers);
    if (after.response.kind === 'data_slot') expect(after.response.dataSlotId).toBe('d2');
  });

  it('never lets a large allowance outlast the author’s own per-slot cap', async () => {
    // Two consecutive turns on the same slot, with five follow-ups unspent throughout. The first is
    // affordable to BOTH limits and gets asked; the second is not the allowance's to give, because
    // the author capped the slot at two attempts. Stated as a sequence deliberately: a single turn
    // sitting already AT the cap proves nothing, since the gate never reaches the clamp — it would
    // pass just as happily if the clamp had been written to ignore the author's limit entirely.
    const budget = { slotIds: ['d1'], spent: 0, allowance: 5 };

    const first = weakOpening({
      attempts: 1,
      cap: 2,
      openingProbe: budget,
      openingRoutability: { routable: false },
    });
    const afterFirst = await runDataSlotTurn(first.state, first.invokers);
    expect(first.calls.routability).toHaveLength(1);
    expect(afterFirst.response.kind).toBe('data_slot');
    if (afterFirst.response.kind === 'data_slot') {
      expect(afterFirst.response.dataSlotId).toBe('d1');
      expect(afterFirst.response.isReask).toBe(true);
    }

    const second = weakOpening({
      attempts: 2,
      cap: 2,
      openingProbe: budget,
      openingRoutability: { routable: false },
    });
    const afterSecond = await runDataSlotTurn(second.state, second.invokers);
    // Four probes still unspent, and the interview moves on anyway.
    expect(afterSecond.response.kind).toBe('data_slot');
    if (afterSecond.response.kind === 'data_slot')
      expect(afterSecond.response.dataSlotId).toBe('d2');
    // …and it never paid a model to tell it something the author's own limit had already settled.
    expect(second.calls.routability).toHaveLength(0);
  });

  it('never gates a first ask, and never pays for a check on one', async () => {
    // `attempts: 0` — nothing has been asked of this slot yet, so there is no follow-up to ration
    // and the allowance (here, zero) must not turn the FIRST question into a park.
    const { state, invokers, calls } = weakOpening({
      attempts: 0,
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 0 },
      openingRoutability: { routable: true },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(calls.routability).toHaveLength(0);
    expect(result.response.kind).toBe('data_slot');
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d1');
  });

  it('never follows up at all on an allowance of zero', async () => {
    const { state, invokers, calls } = weakOpening({
      openingProbe: { slotIds: ['d1'], spent: 0, allowance: 0 },
      openingRoutability: { routable: false },
    });
    const result = await runDataSlotTurn(state, invokers);
    expect(calls.routability).toHaveLength(0);
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
  });

  it('leaves a covered slot alone — a clear answer is never a probe decision', async () => {
    // A `direct` fill is covered whatever its confidence number, so there is no follow-up to weigh
    // and the check must not run (nor the slot be parked).
    const { invokers, calls } = stubInvokers({
      extract: { dataSlotFills: [fill('d1', 0.9, 'direct')] },
      openingRoutability: { routable: false },
    });
    const result = await runDataSlotTurn(
      {
        ...dsState({
          questions: [q({ id: 'q1' })],
          dataSlots: [
            ds({ id: 'd1', key: 'd1', theme: 'A' }),
            ds({ id: 'd2', key: 'd2', theme: 'B' }),
          ],
          activeDataSlotKey: 'd1',
          dataSlotAttempts: { d1: 1 },
          config: { maxDataSlotAttempts: 3 },
        }),
        openingProbe: { slotIds: ['d1'], spent: 0, allowance: 1 },
      },
      invokers
    );
    expect(calls.routability).toHaveLength(0);
    if (result.response.kind === 'data_slot') expect(result.response.dataSlotId).toBe('d2');
  });
});

describe('runDataSlotTurn — must-ask hoist (P18)', () => {
  const ON = { enabled: true, defaultFidelity: 0.5 } as const;
  const OFF = { enabled: false, defaultFidelity: 0.5 } as const;

  /** A must-ask question owned by data slot `d1`, plus a second slot on another theme. */
  const scene = (over: { questionFidelity: typeof ON | typeof OFF }) =>
    dsState({
      questions: [q({ id: 'qa', key: 'q_a', fidelity: 1 }), q({ id: 'qb', key: 'q_b' })],
      dataSlots: [
        ds({ id: 'd1', key: 'd1', theme: 'A', mappedQuestionKeys: ['q_a'] }),
        ds({ id: 'd2', key: 'd2', theme: 'B', mappedQuestionKeys: ['q_b'] }),
      ],
      activeDataSlotKey: 'd1',
      config: { questionFidelity: over.questionFidelity },
    });

  it("waits while the question's own theme is still being worked through", async () => {
    // "Naturally": interrupting a live theme to fire the instrument question would be exactly the
    // form-like intrusion the design avoids. d1 is unfilled, so we keep talking.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(scene({ questionFidelity: ON }), invokers);
    expect(result.response.kind).toBe('data_slot');
  });

  it('asks the must-ask question directly once its owning slot is covered', async () => {
    // "But guaranteed": the moment its ground is done, it is put to the respondent — before we
    // bridge to theme B.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      {
        ...scene({ questionFidelity: ON }),
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
      },
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind !== 'question') return;
    expect(result.response.questionId).toBe('qa');
  });

  it('still asks it when an inference filled it below the must-ask bar', async () => {
    // The tangential-fill case: there IS an answer row, so the ordinary "unanswered" view would
    // consider it done and bridge straight on to theme B.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      {
        ...scene({ questionFidelity: ON }),
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        answered: [{ questionId: 'qa', confidence: 0.75 }],
      },
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind !== 'question') return;
    expect(result.response.questionId).toBe('qa');
  });

  it('asks a must-ask question that no data slot claims without waiting for any theme', async () => {
    // An orphan question has no ground to wind up, so waiting for its "owning" slots would wait
    // forever and leave it to the end-of-run sweep — losing the "asked in context" property.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'qa', key: 'q_a', fidelity: 1 }), q({ id: 'qb', key: 'q_b' })],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'A', mappedQuestionKeys: ['q_b'] })],
        activeDataSlotKey: 'd1',
        config: { questionFidelity: ON },
      }),
      invokers
    );
    expect(result.response.kind).toBe('question');
    if (result.response.kind !== 'question') return;
    expect(result.response.questionId).toBe('qa');
  });

  it('does not hoist when the gate is off', async () => {
    // The no-op guarantee at the targeting layer: identical state, previous behaviour.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      {
        ...scene({ questionFidelity: OFF }),
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
      },
      invokers
    );
    expect(result.response.kind).toBe('data_slot');
  });

  it('does not offer to submit while a must-ask sits below its bar', async () => {
    // Every question has an answer row — the count-based data-slot submit gate would otherwise be
    // satisfied and offer to finish over an instrument question that was never actually asked.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      {
        ...scene({ questionFidelity: ON }),
        dataSlotAnswered: [
          { dataSlotId: 'd1', confidence: 0.9 },
          { dataSlotId: 'd2', confidence: 0.9 },
        ],
        answered: [
          { questionId: 'qa', confidence: 0.75 },
          { questionId: 'qb', confidence: 0.9 },
        ],
      },
      invokers
    );
    expect(result.response.kind).toBe('question');
  });
});

/* ── Stage progress (P20 Phase 2) ─────────────────────────────────────────── */

describe('runDataSlotTurn — stage progress reporting', () => {
  it('reports the same three stages as question mode, in the same order', async () => {
    // Parity matters: a respondent cannot tell which pipeline their questionnaire runs, so the
    // account of the wait must not differ between them.
    const { invokers } = stubInvokers();
    const seen: string[] = [];

    await runDataSlotTurn(
      dsState({
        userMessage: 'we run mostly on referrals',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
      }),
      invokers,
      (s) => seen.push(s)
    );

    expect(seen).toEqual(['reading', 'checking', 'choosing']);
  });

  it('does not claim to be reading an answer on the opening turn', async () => {
    const { invokers } = stubInvokers();
    const seen: string[] = [];

    await runDataSlotTurn(
      dsState({
        userMessage: '',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
      }),
      invokers,
      (s) => seen.push(s)
    );

    expect(seen).not.toContain('reading');
  });

  it('reaches the same decision whether or not a reporter is supplied', async () => {
    const build = () =>
      dsState({
        userMessage: 'mostly referrals',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
      });

    const withReporter = await runDataSlotTurn(build(), stubInvokers().invokers, () => {});
    const without = await runDataSlotTurn(build(), stubInvokers().invokers);

    expect(withReporter).toEqual(without);
  });
});

/* ── Reading the answer: concurrency (P20 Phase 3 / A1) ───────────────────── */

describe('runDataSlotTurn — extraction and sensitivity detection overlap', () => {
  function withTimeout<T>(p: Promise<T>, ms = 2_000): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('extraction and detection did not overlap')), ms)
      ),
    ]);
  }

  it('runs both calls concurrently, exactly as question mode does', async () => {
    // Parity is the point: a respondent cannot tell which pipeline their questionnaire runs, so
    // the saving must not apply to only one of them. Deadlocks if re-serialised.
    let detectionStarted!: () => void;
    const detectionHasStarted = new Promise<void>((resolve) => {
      detectionStarted = resolve;
    });

    const invokers = {
      ...stubInvokers().invokers,
      extractAnswers: async () => {
        await detectionHasStarted;
        return { intents: [], costUsd: 0 };
      },
      detectSensitivity: async () => {
        detectionStarted();
        return { assessment: null, costUsd: 0 };
      },
    };

    const result = await withTimeout(
      runDataSlotTurn(
        dsState({
          userMessage: 'mostly referrals',
          questions: [q({ id: 'q1' })],
          dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
          config: { sensitivityAwareness: true, abuseThreshold: 0 },
        }),
        invokers
      )
    );

    expect(result.response.kind).toBe('data_slot');
  });

  it('still keeps the seriousness judge out of the batch', async () => {
    const { invokers: base, calls } = stubInvokers({
      serious: { verdict: { serious: false, reason: 'sounds implausible' } },
    });
    const invokers = {
      ...base,
      detectSensitivity: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          assessment: {
            detected: true as const,
            severity: 'high' as const,
            category: 'harassment',
            summary: 'discloses harm at work',
          },
          costUsd: 0,
        };
      },
    };

    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'my manager has been making my life hell',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' })],
        config: { sensitivityAwareness: true, abuseThreshold: 4 },
      }),
      invokers
    );

    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
    expect(result.sensitivity?.detected).toBe(true);
  });

  it('preserves the data-slot fills the extraction returned', async () => {
    // The data-slot pipeline reads a field question mode does not (`dataSlotFills`); moving the
    // extraction into a batch must not drop it.
    const invokers = {
      ...stubInvokers().invokers,
      extractAnswers: async () => ({
        intents: [],
        dataSlotFills: [
          {
            dataSlotKey: 'd1',
            value: 'referrals',
            paraphrase: 'mostly referrals',
            provenance: 'direct' as const,
            confidence: 0.9,
          },
        ],
        costUsd: 0,
      }),
    };

    const result = await runDataSlotTurn(
      dsState({
        userMessage: 'mostly referrals',
        questions: [q({ id: 'q1' })],
        dataSlots: [ds({ id: 'd1', theme: 'A' }), ds({ id: 'd2', theme: 'B' })],
        config: { sensitivityAwareness: true, abuseThreshold: 0 },
      }),
      invokers
    );

    expect(result.sideEffects.dataSlotFills).toHaveLength(1);
    expect(result.sideEffects.dataSlotFills?.[0]?.dataSlotKey).toBe('d1');
  });
});

describe('runDataSlotTurn — sectioned interviews (P21)', () => {
  it('reports the part covered instead of sweeping a question out of another part', async () => {
    // Section one's slot is filled and its question answered; section two still owes both. The
    // sweep used to reach past the boundary for `q2` and tag the turn with section one.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' }), q({ id: 'q2' })],
        answered: [{ questionId: 'q1', confidence: 0.9 }],
        dataSlots: [
          ds({ id: 'd1', key: 'd1', theme: 'About', mappedQuestionKeys: ['q1'] }),
          ds({ id: 'd2', key: 'd2', theme: 'Work', mappedQuestionKeys: ['q2'] }),
        ],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
        sectionQuestions: [q({ id: 'q1' })],
        sectionDataSlots: [ds({ id: 'd1', key: 'd1', theme: 'About', mappedQuestionKeys: ['q1'] })],
        sectionMeta: { key: 'about', label: 'About you', nextLabel: 'Your work' },
      }),
      invokers
    );

    expect(result.response.kind).toBe('section_covered');
    if (result.response.kind === 'section_covered') {
      expect(result.response.sectionKey).toBe('about');
      expect(result.response.text).toBe(
        "That's everything for About you. I'll take us on to Your work now."
      );
    }
    expect(result.targetedQuestionId).toBeNull();
  });

  it('still sweeps the remaining question when the interview is not sectioned', async () => {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' }), q({ id: 'q2' })],
        answered: [{ questionId: 'q1', confidence: 0.9 }],
        dataSlots: [ds({ id: 'd1', key: 'd1', theme: 'About', mappedQuestionKeys: ['q1'] })],
        dataSlotAnswered: [{ dataSlotId: 'd1', confidence: 0.9 }],
      }),
      invokers
    );

    expect(result.response.kind).toBe('question');
    expect(result.targetedQuestionId).toBe('q2');
  });
});

describe('runDataSlotTurn — the early-seating bridge (F17.36 phase 4)', () => {
  /**
   * Opening themes A and B; `seated` is the topic chosen early during the opening.
   *
   * Ordinals put the opening first, which is the arrangement that makes the bridge necessary: the
   * seated slot would otherwise never be reached until every opening slot was done.
   */
  const SLOTS = [
    ds({ id: 'a1', key: 'a1', theme: 'A', ordinal: 0 }),
    ds({ id: 'a2', key: 'a2', theme: 'A', ordinal: 1 }),
    ds({ id: 'b1', key: 'b1', theme: 'B', ordinal: 2 }),
    ds({ id: 's1', key: 's1', theme: 'seated', ordinal: 9 }),
    ds({ id: 's2', key: 's2', theme: 'seated', ordinal: 10 }),
  ];

  async function pick(input: Parameters<typeof dsState>[0]) {
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(dsState(input), invokers);
    expect(result.response.kind).toBe('data_slot');
    return result.response.kind === 'data_slot' ? result.response : null;
  }

  it('does NOT interrupt a theme mid-flow', async () => {
    // The whole safety argument. `a1` was just answered and `a2` is still open in the same theme,
    // so the interview stays where it is. Interrupting a line of questioning is exactly what would
    // make an interview feel scattered.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [{ dataSlotId: 'a1', confidence: 0.9 }],
      activeDataSlotKey: 'a1',
      bridgeDataSlotKeys: ['s1', 's2'],
    });

    expect(next?.dataSlotId).toBe('a2');
    expect(next?.isTransition).toBe(false);
  });

  it('moves to the seated area at a transition, instead of the next opening theme', async () => {
    // Theme A is exhausted, so the pick was moving somewhere new regardless. Without the bridge it
    // would go to `b1`; with it, it goes to the area the respondent made obvious.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [
        { dataSlotId: 'a1', confidence: 0.9 },
        { dataSlotId: 'a2', confidence: 0.9 },
      ],
      activeDataSlotKey: 'a2',
      bridgeDataSlotKeys: ['s1', 's2'],
    });

    expect(next?.dataSlotId).toBe('s1');
    // It reads as an ordinary change of subject, which is the point: the framing was already there.
    expect(next?.isTransition).toBe(true);
  });

  it('goes to the next opening theme when there is nothing seated', async () => {
    // The control. Absent `bridgeDataSlotKeys`, targeting is exactly what it always was.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [
        { dataSlotId: 'a1', confidence: 0.9 },
        { dataSlotId: 'a2', confidence: 0.9 },
      ],
      activeDataSlotKey: 'a2',
    });

    expect(next?.dataSlotId).toBe('b1');
  });

  it('returns to the opening once the visit is spent, rather than finishing the topic', async () => {
    // The bound. Both seated slots are covered, so the budget is gone — and critically the ACTIVE
    // theme is the seated one, where the topic-local rule would otherwise hold the interview until
    // the whole area was done, delaying an opening that has not finished.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: [...SLOTS, ds({ id: 's3', key: 's3', theme: 'seated', ordinal: 11 })],
      dataSlotAnswered: [
        { dataSlotId: 'a1', confidence: 0.9 },
        { dataSlotId: 's1', confidence: 0.9 },
        { dataSlotId: 's2', confidence: 0.9 },
      ],
      activeDataSlotKey: 's2',
      bridgeDataSlotKeys: ['s1', 's2', 's3'],
    });

    expect(next?.dataSlotId).toBe('a2');
  });

  it('prefers the seated area when a parked slot forces a move', async () => {
    // Parking is the most explicit transition there is: the interviewer has given up and is moving
    // on regardless. Where it moves TO is exactly this decision.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [],
      activeDataSlotKey: 'a1',
      // At the re-ask cap, so this turn parks `a1` and bridges away from theme A.
      dataSlotAttempts: { a1: 9 },
      bridgeDataSlotKeys: ['s1', 's2'],
    });

    expect(next?.dataSlotId).toBe('s1');
  });

  it('still asks a seated slot when it is all that is left', async () => {
    // A spent budget must never stall the interview. Preferring the opening is a preference, not a
    // prohibition — there is nothing else to ask here.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [
        { dataSlotId: 'a1', confidence: 0.9 },
        { dataSlotId: 'a2', confidence: 0.9 },
        { dataSlotId: 'b1', confidence: 0.9 },
        { dataSlotId: 's1', confidence: 0.9 },
      ],
      activeDataSlotKey: 'b1',
      bridgeDataSlotKeys: ['s1', 's2'],
    });

    expect(next?.dataSlotId).toBe('s2');
  });

  it('ignores a bridge key that names no slot in the pool', async () => {
    // A topic seated on a version whose slots were since edited. Same treatment every unresolvable
    // key gets in this feature: skipped, never a stall.
    const next = await pick({
      questions: [q({ id: 'q1' })],
      dataSlots: SLOTS,
      dataSlotAnswered: [
        { dataSlotId: 'a1', confidence: 0.9 },
        { dataSlotId: 'a2', confidence: 0.9 },
      ],
      activeDataSlotKey: 'a2',
      bridgeDataSlotKeys: ['deleted'],
    });

    expect(next?.dataSlotId).toBe('b1');
  });
});
