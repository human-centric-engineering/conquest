/**
 * newly-filled — snapshot diff that finds the data slots a turn just filled (slot overview minimap).
 *
 * @see lib/app/questionnaire/panel/newly-filled.ts
 */

import { describe, it, expect } from 'vitest';

import {
  dataSlotKeysInOrder,
  diffNewlyFilled,
  diffNewlyFilledQuestions,
  panelSlotDomId,
  recentlyFilledByLatestTurn,
} from '@/lib/app/questionnaire/panel/newly-filled';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

function slot(over: Partial<DataSlotPanelSlot> & { key: string }): DataSlotPanelSlot {
  return {
    name: over.key,
    description: '',
    paraphrase: null,
    provenance: null,
    confidence: null,
    rationale: null,
    filled: false,
    provisional: false,
    answeredAtTurnIndex: null,
    history: [],
    coverage: { total: 0, answered: 0, questions: [] },
    ...over,
  };
}

/** A data-slot-mode view from themed groups (key → its slots in display order). */
function view(groups: Array<{ theme: string; slots: DataSlotPanelSlot[] }>): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    dataSlotGroups: groups,
    progressPercent: 0,
  };
}

describe('panelSlotDomId', () => {
  it('namespaces the slot key', () => {
    expect(panelSlotDomId('goal')).toBe('panel-slot-goal');
  });
});

describe('recentlyFilledByLatestTurn', () => {
  it('returns the keys whose answeredAtTurnIndex equals the maximum', () => {
    const set = recentlyFilledByLatestTurn([
      { key: 'a', answeredAtTurnIndex: 1 },
      { key: 'b', answeredAtTurnIndex: 3 },
      { key: 'c', answeredAtTurnIndex: 3 },
      { key: 'd', answeredAtTurnIndex: 2 },
    ]);
    expect([...set].sort()).toEqual(['b', 'c']);
  });

  it('ignores null indices and returns empty when nothing has been filled', () => {
    expect(recentlyFilledByLatestTurn([]).size).toBe(0);
    expect(
      recentlyFilledByLatestTurn([
        { key: 'a', answeredAtTurnIndex: null },
        { key: 'b', answeredAtTurnIndex: null },
      ]).size
    ).toBe(0);
  });

  it('persists on the latest fill-turn even when only one slot carries the max', () => {
    const set = recentlyFilledByLatestTurn([
      { key: 'a', answeredAtTurnIndex: 5 },
      { key: 'b', answeredAtTurnIndex: null },
      { key: 'c', answeredAtTurnIndex: 4 },
    ]);
    expect([...set]).toEqual(['a']);
  });
});

describe('dataSlotKeysInOrder', () => {
  it('flattens groups then slots in display order', () => {
    const v = view([
      { theme: 'A', slots: [slot({ key: 'a1' }), slot({ key: 'a2' })] },
      { theme: 'B', slots: [slot({ key: 'b1' })] },
    ]);
    expect(dataSlotKeysInOrder(v)).toEqual(['a1', 'a2', 'b1']);
  });

  it('returns [] for null or question-mode views', () => {
    expect(dataSlotKeysInOrder(null)).toEqual([]);
    expect(
      dataSlotKeysInOrder({
        status: 'active',
        scope: 'full_progress',
        sections: [],
        answeredCount: 0,
        totalCount: 0,
      })
    ).toEqual([]);
  });
});

describe('diffNewlyFilled', () => {
  it('returns [] on the first snapshot (prev is null) — never auto-scrolls the seed', () => {
    const next = view([{ theme: 'A', slots: [slot({ key: 'a1', filled: true })] }]);
    expect(diffNewlyFilled(null, next)).toEqual([]);
  });

  it('flags a slot that went from unfilled to filled', () => {
    const prev = view([{ theme: 'A', slots: [slot({ key: 'a1', filled: false })] }]);
    const next = view([
      { theme: 'A', slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 2 })] },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual(['a1']);
  });

  it('ignores a slot that was already filled and unchanged this turn', () => {
    const prev = view([
      { theme: 'A', slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 1 })] },
    ]);
    const next = view([
      { theme: 'A', slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 1 })] },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual([]);
  });

  it('flags a refinement/value change where the turn index advanced (still filled)', () => {
    const prev = view([
      { theme: 'A', slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 1 })] },
    ]);
    const next = view([
      { theme: 'A', slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 3 })] },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual(['a1']);
  });

  it('flags a provisional→confident transition (the trigger is the advanced turn index, not the flag)', () => {
    const prev = view([
      {
        theme: 'A',
        slots: [slot({ key: 'a1', filled: true, provisional: true, answeredAtTurnIndex: 2 })],
      },
    ]);
    const next = view([
      {
        theme: 'A',
        slots: [slot({ key: 'a1', filled: true, provisional: false, answeredAtTurnIndex: 4 })],
      },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual(['a1']);
  });

  it('does NOT flag a provisional→confident flip when the turn index is unchanged', () => {
    // Isolates the real mechanism: the `provisional` field does not drive detection — only a
    // filled-transition or an advanced answeredAtTurnIndex does. Same index ⇒ no re-surface.
    const prev = view([
      {
        theme: 'A',
        slots: [slot({ key: 'a1', filled: true, provisional: true, answeredAtTurnIndex: 2 })],
      },
    ]);
    const next = view([
      {
        theme: 'A',
        slots: [slot({ key: 'a1', filled: true, provisional: false, answeredAtTurnIndex: 2 })],
      },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual([]);
  });

  it('preserves display order across groups for a multi-slot turn', () => {
    const prev = view([
      { theme: 'A', slots: [slot({ key: 'a1' }), slot({ key: 'a2' })] },
      { theme: 'B', slots: [slot({ key: 'b1' })] },
    ]);
    const next = view([
      {
        theme: 'A',
        slots: [slot({ key: 'a1', filled: true, answeredAtTurnIndex: 2 }), slot({ key: 'a2' })],
      },
      { theme: 'B', slots: [slot({ key: 'b1', filled: true, answeredAtTurnIndex: 2 })] },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual(['a1', 'b1']);
  });

  it('returns [] when the previous snapshot was not in data-slot mode (no comparable baseline)', () => {
    const questionModePrev: AnswerPanelView = {
      status: 'active',
      scope: 'full_progress',
      sections: [],
      answeredCount: 0,
      totalCount: 0,
    };
    const next = view([{ theme: 'A', slots: [slot({ key: 'a1', filled: true })] }]);
    // Must NOT report the already-filled slot as new just because the prior view had no data slots.
    expect(diffNewlyFilled(questionModePrev, next)).toEqual([]);
  });

  it('returns [] when next is null or not in data-slot mode', () => {
    const prev = view([{ theme: 'A', slots: [slot({ key: 'a1' })] }]);
    expect(diffNewlyFilled(prev, null)).toEqual([]);
    expect(
      diffNewlyFilled(prev, {
        status: 'active',
        scope: 'full_progress',
        sections: [],
        answeredCount: 0,
        totalCount: 0,
      })
    ).toEqual([]);
  });

  it('treats a slot newly present and filled (not in prev) as newly filled', () => {
    const prev = view([{ theme: 'A', slots: [slot({ key: 'a1', filled: true })] }]);
    const next = view([
      {
        theme: 'A',
        slots: [
          slot({ key: 'a1', filled: true }),
          slot({ key: 'a2', filled: true, answeredAtTurnIndex: 2 }),
        ],
      },
    ]);
    expect(diffNewlyFilled(prev, next)).toEqual(['a2']);
  });
});

function qSlot(over: Partial<PanelSlotView> & { slotKey: string }): PanelSlotView {
  return {
    prompt: over.slotKey,
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: false,
    value: null,
    provenance: null,
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: null,
    refinementHistory: [],
    ...over,
  };
}

/** A question-mode view from sections (sectionId → its slots in display order). */
function qView(sections: Array<{ sectionId: string; slots: PanelSlotView[] }>): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: sections.map((s) => ({ sectionId: s.sectionId, title: s.sectionId, slots: s.slots })),
    answeredCount: 0,
    totalCount: 0,
  };
}

describe('diffNewlyFilledQuestions', () => {
  it('returns [] on the first snapshot (prev is null)', () => {
    const next = qView([{ sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true })] }]);
    expect(diffNewlyFilledQuestions(null, next)).toEqual([]);
  });

  it('flags a question that went from unanswered to answered', () => {
    const prev = qView([{ sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: false })] }]);
    const next = qView([
      { sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true, answeredAtTurnIndex: 2 })] },
    ]);
    expect(diffNewlyFilledQuestions(prev, next)).toEqual(['q1']);
  });

  it('ignores an answer that was already captured and unchanged this turn', () => {
    const prev = qView([
      { sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true, answeredAtTurnIndex: 1 })] },
    ]);
    const next = qView([
      { sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true, answeredAtTurnIndex: 1 })] },
    ]);
    expect(diffNewlyFilledQuestions(prev, next)).toEqual([]);
  });

  it('flags a refinement where the turn index advanced (still answered)', () => {
    const prev = qView([
      { sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true, answeredAtTurnIndex: 1 })] },
    ]);
    const next = qView([
      { sectionId: 'S', slots: [qSlot({ slotKey: 'q1', answered: true, answeredAtTurnIndex: 3 })] },
    ]);
    expect(diffNewlyFilledQuestions(prev, next)).toEqual(['q1']);
  });

  it('preserves section then slot display order for a multi-question turn', () => {
    const prev = qView([
      { sectionId: 'S1', slots: [qSlot({ slotKey: 'a' }), qSlot({ slotKey: 'b' })] },
      { sectionId: 'S2', slots: [qSlot({ slotKey: 'c' })] },
    ]);
    const next = qView([
      {
        sectionId: 'S1',
        slots: [
          qSlot({ slotKey: 'a', answered: true, answeredAtTurnIndex: 2 }),
          qSlot({ slotKey: 'b' }),
        ],
      },
      { sectionId: 'S2', slots: [qSlot({ slotKey: 'c', answered: true, answeredAtTurnIndex: 2 })] },
    ]);
    expect(diffNewlyFilledQuestions(prev, next)).toEqual(['a', 'c']);
  });

  it('returns [] when either snapshot is in data-slot mode (use diffNewlyFilled there)', () => {
    const dataView = view([{ theme: 'A', slots: [slot({ key: 'a1', filled: true })] }]);
    const qPrev = qView([{ sectionId: 'S', slots: [qSlot({ slotKey: 'q1' })] }]);
    expect(diffNewlyFilledQuestions(dataView, qView([]))).toEqual([]);
    expect(diffNewlyFilledQuestions(qPrev, dataView)).toEqual([]);
  });
});
