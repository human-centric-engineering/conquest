/**
 * Unit test: answer-slot panel pure projection (F7.2).
 *
 * Covers the join (answered + pending), section ordering pass-through, scope
 * filtering (answered_only drops pending slots and empty sections while keeping an
 * honest totalCount), count derivation, type/provenance narrowing, and that the
 * refinement history + turn index pass through untouched.
 */

import { describe, it, expect } from 'vitest';

import {
  buildAnswerPanelView,
  type PanelBuilderInput,
} from '@/lib/app/questionnaire/panel/answer-panel';

function input(over: Partial<PanelBuilderInput> = {}): PanelBuilderInput {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [
      {
        sectionId: 's1',
        title: 'About you',
        slots: [
          { slotKey: 'role', prompt: 'Role?', type: 'free_text', required: true },
          { slotKey: 'team', prompt: 'Team size?', type: 'numeric', required: false },
        ],
      },
      {
        sectionId: 's2',
        title: 'Preferences',
        slots: [
          { slotKey: 'colour', prompt: 'Favourite colour?', type: 'free_text', required: false },
        ],
      },
    ],
    answers: [
      {
        slotKey: 'role',
        value: 'Engineer',
        provenance: 'direct',
        confidence: 0.9,
        rationale: 'Stated directly.',
        answeredAtTurnIndex: 2,
        refinementHistory: [],
      },
    ],
    ...over,
  };
}

describe('buildAnswerPanelView — full_progress', () => {
  it('joins answers onto slots and marks the rest pending', () => {
    const view = buildAnswerPanelView(input());
    const role = view.sections[0].slots[0];
    const team = view.sections[0].slots[1];

    expect(role.answered).toBe(true);
    expect(role.value).toBe('Engineer');
    expect(role.provenance).toBe('direct');
    expect(role.confidence).toBe(0.9);
    expect(role.rationale).toBe('Stated directly.');
    expect(role.answeredAtTurnIndex).toBe(2);

    expect(team.answered).toBe(false);
    expect(team.value).toBeNull();
    expect(team.provenance).toBeNull();
    expect(team.confidence).toBeNull();
    expect(team.rationale).toBeNull();
    expect(team.answeredAtTurnIndex).toBeNull();
  });

  it('preserves section order and keeps empty-of-answers sections', () => {
    const view = buildAnswerPanelView(input());
    expect(view.sections.map((s) => s.sectionId)).toEqual(['s1', 's2']);
    expect(view.sections[1].slots).toHaveLength(1);
    expect(view.sections[1].slots[0].answered).toBe(false);
  });

  it('derives answered and total counts across all sections', () => {
    const view = buildAnswerPanelView(input());
    expect(view.answeredCount).toBe(1);
    expect(view.totalCount).toBe(3);
  });

  it('passes the scope and status through', () => {
    const view = buildAnswerPanelView(input({ status: 'completed' }));
    expect(view.status).toBe('completed');
    expect(view.scope).toBe('full_progress');
  });
});

describe('buildAnswerPanelView — answered_only', () => {
  it('omits pending slots and drops sections left empty, but keeps totalCount honest', () => {
    const view = buildAnswerPanelView(input({ scope: 'answered_only' }));
    expect(view.scope).toBe('answered_only');
    // Only the answered 'role' slot survives, in section s1; s2 is dropped entirely.
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].sectionId).toBe('s1');
    expect(view.sections[0].slots.map((s) => s.slotKey)).toEqual(['role']);
    // Counts still reflect the whole version.
    expect(view.answeredCount).toBe(1);
    expect(view.totalCount).toBe(3);
  });
});

describe('buildAnswerPanelView — narrowing & history', () => {
  it('defaults an unknown stored type to free_text and unknown provenance to direct', () => {
    const view = buildAnswerPanelView(
      input({
        sections: [
          {
            sectionId: 's1',
            title: 'S',
            slots: [{ slotKey: 'x', prompt: 'X?', type: 'bogus_type', required: false }],
          },
        ],
        answers: [
          {
            slotKey: 'x',
            value: 1,
            provenance: 'made_up',
            confidence: null,
            rationale: null,
            answeredAtTurnIndex: null,
            refinementHistory: [],
          },
        ],
      })
    );
    const slot = view.sections[0].slots[0];
    expect(slot.type).toBe('free_text');
    expect(slot.provenance).toBe('direct');
  });

  it('passes refinement history through untouched', () => {
    const history = [
      {
        previousValue: 'Dev',
        previousProvenance: 'direct' as const,
        newValue: 'Engineer',
        rationale: 'Clarified.',
        source: 'clarification' as const,
        turnIndex: 2,
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    ];
    const view = buildAnswerPanelView(
      input({
        answers: [
          {
            slotKey: 'role',
            value: 'Engineer',
            provenance: 'refined',
            confidence: 0.8,
            rationale: null,
            answeredAtTurnIndex: 2,
            refinementHistory: history,
          },
        ],
      })
    );
    expect(view.sections[0].slots[0].refinementHistory).toEqual(history);
  });
});
