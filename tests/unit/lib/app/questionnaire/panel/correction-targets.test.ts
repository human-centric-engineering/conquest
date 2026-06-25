/**
 * correction-targets — resolve a turn's just-filled keys into editable "fix this answer" targets
 * (Variant B), in both question and data-slot mode.
 *
 * @see lib/app/questionnaire/panel/correction-targets.ts
 */

import { describe, it, expect } from 'vitest';

import { buildCorrectionTargets } from '@/lib/app/questionnaire/panel/correction-targets';
import type {
  AnswerPanelView,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

function qSlot(over: Partial<PanelSlotView> & { slotKey: string }): PanelSlotView {
  return {
    prompt: `Prompt for ${over.slotKey}`,
    type: 'free_text',
    typeConfig: null,
    required: false,
    answered: true,
    value: 'an answer',
    provenance: 'direct',
    confidence: 1,
    rationale: null,
    answeredAtTurnIndex: 1,
    refinementHistory: [],
    ...over,
  };
}

function questionView(slots: PanelSlotView[]): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [{ sectionId: 'S', title: 'S', slots }],
    answeredCount: slots.filter((s) => s.answered).length,
    totalCount: slots.length,
  };
}

function dataSlot(over: Partial<DataSlotPanelSlot> & { key: string }): DataSlotPanelSlot {
  return {
    name: `Name ${over.key}`,
    description: '',
    paraphrase: null,
    provenance: null,
    confidence: null,
    rationale: null,
    filled: true,
    provisional: false,
    answeredAtTurnIndex: 1,
    history: [],
    coverage: { total: 0, answered: 0, questions: [] },
    ...over,
  };
}

function dataView(slots: DataSlotPanelSlot[]): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    dataSlotGroups: [{ theme: 'T', slots }],
    progressPercent: 0,
  };
}

describe('buildCorrectionTargets — question mode', () => {
  it('resolves each key to a single-question target carrying the slot and its value', () => {
    const view = questionView([
      qSlot({ slotKey: 'role', prompt: 'Your role?', value: 'Engineer', type: 'free_text' }),
    ]);
    const targets = buildCorrectionTargets(view, ['role']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ key: 'role', label: 'Your role?', summary: 'Engineer' });
    expect(targets[0].questions).toEqual([
      {
        slot: { slotKey: 'role', prompt: 'Your role?', type: 'free_text', typeConfig: null },
        initialValue: 'Engineer',
      },
    ]);
  });

  it('formats the summary with choice labels, not stored keys', () => {
    const view = questionView([
      qSlot({
        slotKey: 'sat',
        prompt: 'Satisfaction',
        type: 'single_choice',
        typeConfig: {
          choices: [
            { value: 'opt_1', label: 'Very satisfied' },
            { value: 'opt_2', label: 'Unhappy' },
          ],
        },
        value: 'opt_1',
      }),
    ]);
    const [target] = buildCorrectionTargets(view, ['sat']);
    expect(target.summary).toBe('Very satisfied');
  });

  it('preserves the order of the requested keys and skips unanswered / unknown slots', () => {
    const view = questionView([
      qSlot({ slotKey: 'a', value: 'A' }),
      qSlot({ slotKey: 'b', answered: false, value: null }),
      qSlot({ slotKey: 'c', value: 'C' }),
    ]);
    const targets = buildCorrectionTargets(view, ['c', 'b', 'a', 'missing']);
    expect(targets.map((t) => t.key)).toEqual(['c', 'a']);
  });

  it('returns [] for a null view or no keys', () => {
    expect(buildCorrectionTargets(null, ['a'])).toEqual([]);
    expect(buildCorrectionTargets(questionView([qSlot({ slotKey: 'a' })]), [])).toEqual([]);
  });
});

describe('buildCorrectionTargets — data-slot mode', () => {
  it('resolves a data slot to its mapped questions as editable targets', () => {
    const view = dataView([
      dataSlot({
        key: 'context',
        name: 'Sales context',
        paraphrase: 'Sells direct, blocked by leads',
        coverage: {
          total: 2,
          answered: 1,
          questions: [
            {
              key: 'sell',
              label: 'How do you sell?',
              type: 'free_text',
              typeConfig: null,
              answered: true,
              confidence: 0.9,
              value: 'Direct',
            },
            {
              key: 'block',
              label: 'What blocks you?',
              type: 'free_text',
              typeConfig: null,
              answered: false,
              confidence: null,
              value: null,
            },
          ],
        },
      }),
    ]);
    const targets = buildCorrectionTargets(view, ['context']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: 'context',
      label: 'Sales context',
      summary: 'Sells direct, blocked by leads',
    });
    expect(targets[0].questions).toEqual([
      {
        slot: { slotKey: 'sell', prompt: 'How do you sell?', type: 'free_text', typeConfig: null },
        initialValue: 'Direct',
      },
      {
        slot: { slotKey: 'block', prompt: 'What blocks you?', type: 'free_text', typeConfig: null },
        initialValue: null,
      },
    ]);
  });

  it('drops a data slot with no mapped questions (nothing editable)', () => {
    const view = dataView([
      dataSlot({ key: 'vibe', coverage: { total: 0, answered: 0, questions: [] } }),
    ]);
    expect(buildCorrectionTargets(view, ['vibe'])).toEqual([]);
  });
});
