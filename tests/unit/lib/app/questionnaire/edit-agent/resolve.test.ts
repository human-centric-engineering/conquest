/**
 * Unit tests for the Structure Edit Agent's deterministic executor (`resolveOps`).
 *
 * These assert what the executor DOES to a structure — the concrete before→after change list each op
 * produces, that untouched fields are preserved, and that structurally-impossible ops throw — not
 * just that it returns something (anti-green-bar).
 */

import { describe, it, expect } from 'vitest';

import { resolveOps, EditOpError } from '@/lib/app/questionnaire/edit-agent/resolve';
import type { EditOp } from '@/lib/app/questionnaire/edit-agent/edit-ops';
import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';

function fixture(): EditableStructure {
  return {
    versionId: 'v1',
    sections: [
      {
        id: 'sec-a',
        ordinal: 0,
        title: 'Background',
        description: null,
        questions: [
          {
            id: 'q-a1',
            key: 'name',
            ordinal: 0,
            prompt: 'Your name?',
            type: 'free_text',
            required: true,
            weight: 0.5,
          },
          {
            id: 'q-a2',
            key: 'age',
            ordinal: 1,
            prompt: 'Your age?',
            type: 'numeric',
            required: true,
            weight: 0.8,
          },
        ],
      },
      {
        id: 'sec-b',
        ordinal: 1,
        title: 'Feedback',
        description: 'Optional',
        questions: [
          {
            id: 'q-b1',
            key: 'likes',
            ordinal: 0,
            prompt: 'What did you like?',
            type: 'free_text',
            required: false,
            weight: 0.5,
          },
        ],
      },
    ],
  };
}

describe('resolveOps — set_required', () => {
  it('flips required only on free-text questions and preserves weight + other fields', () => {
    const ops: EditOp[] = [
      { op: 'set_required', target: { scope: 'type', questionType: 'free_text' }, value: false },
    ];
    const { changes, desired } = resolveOps(fixture(), ops);

    // Only the two free-text questions that were `required: true` change (q-b1 was already false → no-op).
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      entityId: 'q-a1',
      key: 'name',
      field: 'question.required',
      before: 'required',
      after: 'optional',
      value: false,
    });

    // The numeric question is untouched; weights are preserved everywhere.
    const flat = desired.sections.flatMap((s) => s.questions);
    expect(flat.find((q) => q.id === 'q-a2')).toMatchObject({ required: true, weight: 0.8 });
    expect(flat.find((q) => q.id === 'q-a1')).toMatchObject({ required: false, weight: 0.5 });
  });

  it('targets a single section by ordinal', () => {
    const ops: EditOp[] = [
      { op: 'set_required', target: { scope: 'section', sectionOrdinal: 1 }, value: true },
    ];
    const { changes } = resolveOps(fixture(), ops);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityId: 'q-b1', field: 'question.required', value: true });
  });

  it('targets explicit keys', () => {
    const ops: EditOp[] = [
      { op: 'set_required', target: { scope: 'keys', keys: ['age'] }, value: false },
    ];
    const { changes } = resolveOps(fixture(), ops);
    expect(changes.map((c) => c.entityId)).toEqual(['q-a2']);
  });
});

describe('resolveOps — text transforms', () => {
  it('uppercases every section title', () => {
    const ops: EditOp[] = [
      { op: 'transform_title', target: { scope: 'all' }, transform: 'uppercase' },
    ];
    const { changes } = resolveOps(fixture(), ops);
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.after)).toEqual(['BACKGROUND', 'FEEDBACK']);
    expect(changes.every((c) => c.field === 'section.title')).toBe(true);
  });

  it('transforms prompts for matched questions only', () => {
    const ops: EditOp[] = [
      {
        op: 'transform_prompt',
        target: { scope: 'type', questionType: 'free_text' },
        transform: 'uppercase',
      },
    ];
    const { changes } = resolveOps(fixture(), ops);
    expect(changes.map((c) => c.entityId).sort()).toEqual(['q-a1', 'q-b1']);
    expect(changes.every((c) => c.field === 'question.prompt')).toBe(true);
  });
});

describe('resolveOps — renumber_sections', () => {
  it('prefixes each title with its 1-based position', () => {
    const ops: EditOp[] = [{ op: 'renumber_sections', style: 'prefix-number' }];
    const { changes } = resolveOps(fixture(), ops);
    expect(changes.map((c) => c.after)).toEqual(['1. Background', '2. Feedback']);
  });

  it('strips an existing numeric prefix', () => {
    const struct = fixture();
    struct.sections[0].title = '1. Background';
    struct.sections[1].title = '2) Feedback';
    const { changes } = resolveOps(struct, [{ op: 'renumber_sections', style: 'strip-number' }]);
    expect(changes.map((c) => c.after)).toEqual(['Background', 'Feedback']);
  });
});

describe('resolveOps — reorder_sections', () => {
  it('swaps order and reports the new positions', () => {
    const { changes } = resolveOps(fixture(), [{ op: 'reorder_sections', order: [1, 0] }]);
    const ordinalChanges = changes.filter((c) => c.field === 'section.ordinal');
    expect(ordinalChanges).toHaveLength(2);
    expect(ordinalChanges.find((c) => c.entityId === 'sec-b')).toMatchObject({ value: 0 });
    expect(ordinalChanges.find((c) => c.entityId === 'sec-a')).toMatchObject({ value: 1 });
  });

  it('throws EditOpError when order is not a permutation', () => {
    expect(() => resolveOps(fixture(), [{ op: 'reorder_sections', order: [0, 0] }])).toThrow(
      EditOpError
    );
  });
});

describe('resolveOps — move_question', () => {
  it('moves a question to another section', () => {
    const { changes, desired } = resolveOps(fixture(), [
      { op: 'move_question', key: 'age', toSectionOrdinal: 1 },
    ]);
    const moved = changes.find((c) => c.field === 'question.section');
    expect(moved).toMatchObject({ entityId: 'q-a2', toSectionId: 'sec-b' });
    expect(desired.sections[1].questions.map((q) => q.key)).toContain('age');
    expect(desired.sections[0].questions.map((q) => q.key)).not.toContain('age');
  });

  it('throws when the question key does not exist', () => {
    expect(() =>
      resolveOps(fixture(), [{ op: 'move_question', key: 'nope', toSectionOrdinal: 1 }])
    ).toThrow(EditOpError);
  });
});

describe('resolveOps — composition + no-op', () => {
  it('returns no changes when nothing matches', () => {
    const { changes } = resolveOps(fixture(), [
      { op: 'set_required', target: { scope: 'type', questionType: 'date' }, value: false },
    ]);
    expect(changes).toEqual([]);
  });

  it('applies multiple ops and only reports fields that actually changed', () => {
    const { changes } = resolveOps(fixture(), [
      { op: 'set_required', target: { scope: 'all' }, value: false },
      { op: 'set_weight', target: { scope: 'keys', keys: ['name'] }, value: 0.5 }, // already 0.5 → no-op
    ]);
    // Two were required (q-a1, q-a2) → 2 required changes; the weight op is a no-op.
    expect(changes.filter((c) => c.field === 'question.required')).toHaveLength(2);
    expect(changes.filter((c) => c.field === 'question.weight')).toHaveLength(0);
  });
});
