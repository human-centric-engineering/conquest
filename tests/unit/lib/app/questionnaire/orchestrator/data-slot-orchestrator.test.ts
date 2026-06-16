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
  DATA_SLOT_COMPLETE_MESSAGE,
  DATA_SLOT_SELECTION_TOOL_SLUG,
  PROVISIONAL_FLOOR_CONFIDENCE,
  type DataSlotTarget,
  type DataSlotAnsweredView,
  type TurnState,
} from '@/lib/app/questionnaire/orchestrator';
import type { DataSlotFillIntent } from '@/lib/app/questionnaire/extraction/types';
import { ABUSE_ABANDON_MESSAGE } from '@/lib/app/questionnaire/seriousness';
import {
  state,
  stubInvokers,
  intent,
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
  config?: Partial<TurnState['config']>;
  flags?: Partial<TurnState['flags']>;
}): TurnState {
  return {
    ...state({
      userMessage: input.userMessage ?? 'hi',
      questions: input.questions,
      answered: input.answered ?? [],
      ...(input.config ? { config: input.config } : {}),
      ...(input.flags ? { flags: input.flags } : {}),
    }),
    dataSlots: input.dataSlots,
    dataSlotAnswered: input.dataSlotAnswered ?? [],
    activeDataSlotKey: input.activeDataSlotKey ?? null,
    ...(input.dataSlotAttempts ? { dataSlotAttempts: input.dataSlotAttempts } : {}),
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

  it('emits DATA_SLOT_COMPLETE_MESSAGE when all questions answered but completion flag is off', async () => {
    // When flags.completion is false the offer-prose path is disabled, so the orchestrator falls
    // through to the deterministic DATA_SLOT_COMPLETE_MESSAGE terminal frame instead of invoking
    // the streaming offer composer. This is a distinct constant from question-mode COMPLETE_MESSAGE.
    const { invokers } = stubInvokers();
    const result = await runDataSlotTurn(
      dsState({
        questions: [q({ id: 'q1' })],
        answered: [{ questionId: 'q1', confidence: 0.9 }],
        dataSlots: [ds({ id: 'd1', theme: 'A' })],
        dataSlotAnswered: [],
        flags: { completion: false },
      }),
      invokers
    );
    expect(result.response.kind).toBe('complete');
    if (result.response.kind === 'complete') {
      expect(result.response.text).toBe(DATA_SLOT_COMPLETE_MESSAGE);
    }
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
    expect(result.response).toEqual({ kind: 'complete', text: ABUSE_ABANDON_MESSAGE });
    expect(result.sideEffects.dataSlotFills).toHaveLength(0);
    // No side-band notices on the terminal turn (the extraction diagnostic is dropped).
    expect(result.events).toEqual([]);
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
