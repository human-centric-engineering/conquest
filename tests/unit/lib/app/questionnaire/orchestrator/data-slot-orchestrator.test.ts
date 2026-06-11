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
  type DataSlotTarget,
  type DataSlotAnsweredView,
  type TurnState,
} from '@/lib/app/questionnaire/orchestrator';
import type { DataSlotFillIntent } from '@/lib/app/questionnaire/extraction/types';
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

/** A data-slot-mode TurnState: base state + data slots / fills / active slot. */
function dsState(input: {
  userMessage?: string;
  questions: TurnState['questions'];
  answered?: TurnState['answered'];
  dataSlots: DataSlotTarget[];
  dataSlotAnswered?: DataSlotAnsweredView[];
  activeDataSlotKey?: string | null;
}): TurnState {
  return {
    ...state({
      userMessage: input.userMessage ?? 'hi',
      questions: input.questions,
      answered: input.answered ?? [],
    }),
    dataSlots: input.dataSlots,
    dataSlotAnswered: input.dataSlotAnswered ?? [],
    activeDataSlotKey: input.activeDataSlotKey ?? null,
  };
}

const fill = (key: string, confidence = 0.9): DataSlotFillIntent => ({
  dataSlotKey: key,
  value: 'pos',
  paraphrase: `paraphrase for ${key}`,
  confidence,
  provenance: 'direct',
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
