/**
 * Unit test: the panel builder surfaces a free-text answer's living paraphrase onto its slot view.
 */

import { describe, it, expect } from 'vitest';

import { buildAnswerPanelView } from '@/lib/app/questionnaire/panel/answer-panel';
import type { PanelBuilderInput } from '@/lib/app/questionnaire/panel/answer-panel';

function input(over?: Partial<PanelBuilderInput['answers'][number]>): PanelBuilderInput {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [
      {
        sectionId: 's1',
        title: 'Strategy',
        slots: [{ slotKey: 'comments', prompt: 'Comments?', type: 'free_text', required: false }],
      },
    ],
    answers: [
      {
        slotKey: 'comments',
        value: 'no - the playbook took ages and cost lots but we never use it',
        paraphrase: 'They say the playbook is "just a document" they "don\'t use".',
        provenance: 'direct',
        confidence: 0.8,
        rationale: 'described not using it',
        answeredAtTurnIndex: 3,
        refinementHistory: [],
        ...over,
      },
    ],
  };
}

describe('buildAnswerPanelView — free-text paraphrase', () => {
  it('carries the paraphrase onto the slot view (distinct from the raw value)', () => {
    const view = buildAnswerPanelView(input());
    const slot = view.sections[0]?.slots[0];
    expect(slot?.paraphrase).toBe('They say the playbook is "just a document" they "don\'t use".');
    expect(slot?.value).toContain('took ages'); // raw value preserved
  });

  it('leaves paraphrase null for an answer that has none', () => {
    const view = buildAnswerPanelView(input({ paraphrase: null }));
    expect(view.sections[0]?.slots[0]?.paraphrase ?? null).toBeNull();
  });
});
