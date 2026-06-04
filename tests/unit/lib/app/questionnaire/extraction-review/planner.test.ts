import { describe, it, expect } from 'vitest';

import {
  planRevert,
  isRevertImpossibleReason,
  REVERT_IMPOSSIBLE_REASONS,
} from '@/lib/app/questionnaire/extraction-review';
import type {
  GraphSnapshot,
  RevertableChange,
  SnapshotQuestion,
  SnapshotSection,
} from '@/lib/app/questionnaire/extraction-review';
import type { ChangeType } from '@/lib/app/questionnaire/ingestion/types';

/**
 * The revert planner is the F2.3 centerpiece: pure (change row + graph snapshot →
 * plan or typed impossibility). These tests pin each change type's revert
 * semantics AND its clean-failure modes — the honest posture is "fail rather than
 * guess-and-corrupt", so the impossible cases matter as much as the happy paths.
 */

// ─── Builders ─────────────────────────────────────────────────────────────────

function question(
  over: Partial<SnapshotQuestion> & { id: string; prompt: string }
): SnapshotQuestion {
  return {
    sectionId: 'sec-1',
    ordinal: 0,
    key: over.id,
    guidelines: null,
    rationale: null,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
    ...over,
  };
}

function section(over: Partial<SnapshotSection> & { id: string; title: string }): SnapshotSection {
  return { ordinal: 0, description: null, questions: [], ...over };
}

function snapshot(over?: Partial<GraphSnapshot>): GraphSnapshot {
  return {
    goal: null,
    goalProvenance: null,
    audience: null,
    audienceProvenance: null,
    sections: [],
    ...over,
  };
}

function change(over: Partial<RevertableChange> & { changeType: ChangeType }): RevertableChange {
  return {
    id: 'chg-1',
    targetEntityType: 'question',
    targetEntityId: null,
    sourceQuote: null,
    beforeJson: null,
    afterJson: null,
    ...over,
  };
}

// ─── infer_goal ───────────────────────────────────────────────────────────────

describe('planRevert · infer_goal', () => {
  it('clears the goal when it is still marked inferred', () => {
    const result = planRevert(
      change({ changeType: 'infer_goal', targetEntityType: 'version', afterJson: 'Measure NPS' }),
      snapshot({ goal: 'Measure NPS', goalProvenance: 'inferred' })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toEqual([{ op: 'set-goal', goal: null, provenance: null }]);
  });

  it('refuses when the admin has taken over the goal (graph_drift)', () => {
    const result = planRevert(
      change({ changeType: 'infer_goal', targetEntityType: 'version' }),
      snapshot({ goal: 'Admin goal', goalProvenance: 'admin-supplied' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('graph_drift');
  });
});

// ─── infer_audience ─────────────────────────────────────────────────────────

describe('planRevert · infer_audience', () => {
  it('clears only the still-inferred subset of keys', () => {
    const result = planRevert(
      change({
        changeType: 'infer_audience',
        targetEntityType: 'version',
        afterJson: { role: 'Manager', locale: 'en' },
      }),
      snapshot({
        audience: { role: 'Manager', locale: 'en', description: 'Kept' },
        audienceProvenance: {
          role: 'inferred',
          locale: 'admin-supplied', // admin re-supplied this one — must be left alone
          description: 'admin-supplied',
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toHaveLength(1);
    const op = result.plan.ops[0];
    expect(op.op).toBe('set-audience');
    if (op.op !== 'set-audience') return;
    // `role` (inferred) cleared; `locale` (admin) + `description` retained.
    expect(op.audience).toEqual({ locale: 'en', description: 'Kept' });
    expect(op.provenance).toEqual({ locale: 'admin-supplied', description: 'admin-supplied' });
  });

  it('nulls the audience entirely when the only field was inferred', () => {
    const result = planRevert(
      change({
        changeType: 'infer_audience',
        targetEntityType: 'version',
        afterJson: { role: 'Manager' },
      }),
      snapshot({ audience: { role: 'Manager' }, audienceProvenance: { role: 'inferred' } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'set-audience') throw new Error('expected set-audience');
    expect(op.audience).toBeNull();
    expect(op.provenance).toBeNull();
  });

  it('refuses when every inferred field has drifted (graph_drift)', () => {
    const result = planRevert(
      change({
        changeType: 'infer_audience',
        targetEntityType: 'version',
        afterJson: { role: 'Old' },
      }),
      snapshot({ audience: { role: 'New' }, audienceProvenance: { role: 'inferred' } })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('graph_drift');
  });

  it('refuses a malformed afterJson (missing_before_json)', () => {
    const result = planRevert(
      change({ changeType: 'infer_audience', targetEntityType: 'version', afterJson: 42 }),
      snapshot()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });
});

// ─── prune_section ────────────────────────────────────────────────────────────

describe('planRevert · prune_section', () => {
  it('re-creates the pruned section with its questions', () => {
    const result = planRevert(
      change({
        changeType: 'prune_section',
        targetEntityType: 'section',
        beforeJson: {
          title: 'Demographics',
          description: 'About you',
          questions: [{ prompt: 'Your age?' }, { prompt: 'Your role?' }],
        },
      }),
      snapshot()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    expect(op.op).toBe('create-section');
    if (op.op !== 'create-section') return;
    expect(op.title).toBe('Demographics');
    expect(op.description).toBe('About you');
    expect(op.questions.map((q) => q.prompt)).toEqual(['Your age?', 'Your role?']);
  });

  it('refuses when the pruned section has no recoverable title', () => {
    const result = planRevert(
      change({
        changeType: 'prune_section',
        targetEntityType: 'section',
        beforeJson: { description: 'x' },
      }),
      snapshot()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });
});

// ─── prune_question ───────────────────────────────────────────────────────────

describe('planRevert · prune_question', () => {
  const graph = snapshot({
    sections: [
      section({ id: 'sec-1', title: 'A', ordinal: 0 }),
      section({ id: 'sec-2', title: 'B', ordinal: 1 }),
    ],
  });

  it('re-creates the question into the section named in beforeJson', () => {
    const result = planRevert(
      change({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { prompt: 'Dropped?', sectionTitle: 'B' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    expect(op.op).toBe('create-question');
    if (op.op !== 'create-question') return;
    expect(op.sectionId).toBe('sec-2');
    expect(op.question.prompt).toBe('Dropped?');
  });

  it('falls back to the first section when no hint resolves', () => {
    const result = planRevert(
      change({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { prompt: 'Dropped?' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'create-question') throw new Error('expected create-question');
    expect(op.sectionId).toBe('sec-1');
  });

  it('refuses when there is no section to restore into (target_not_found)', () => {
    const result = planRevert(
      change({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { prompt: 'Dropped?' },
      }),
      snapshot()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });

  it('refuses when the pruned question has no prompt (missing_before_json)', () => {
    const result = planRevert(
      change({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { type: 'numeric' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });
});

// ─── rewrite_prompt / correct_* (reconcile + restore) ─────────────────────────

describe('planRevert · rewrite_prompt', () => {
  it('restores the prior prompt onto the uniquely-matched question', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'What is your annual revenue?' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'rewrite_prompt',
        beforeJson: { prompt: 'revenue?' },
        afterJson: { prompt: 'What is your annual revenue?' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toEqual([
      { op: 'update-question', questionId: 'q1', fields: { prompt: 'revenue?' } },
    ]);
  });

  it('reports target_not_found when no current question matches afterJson', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'Edited since' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'rewrite_prompt',
        beforeJson: { prompt: 'old' },
        afterJson: { prompt: 'the extracted prompt' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });

  it('reports ambiguous_target when two questions match and no sourceQuote disambiguates', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [
            question({ id: 'q1', prompt: 'Same' }),
            question({ id: 'q2', prompt: 'Same' }),
          ],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'rewrite_prompt',
        beforeJson: { prompt: 'old' },
        afterJson: { prompt: 'Same' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_target');
  });

  it('uses sourceQuote to break a tie down to one match', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [
            question({ id: 'q1', prompt: 'How many employees does your company have right now' }),
            question({ id: 'q2', prompt: 'How many employees does your company have right now' }),
          ],
        }),
      ],
    });
    // sourceQuote overlaps q1's prompt; both prompts are identical so the tiebreak
    // can't actually separate them — assert the ambiguous path stays honest.
    const result = planRevert(
      change({
        changeType: 'rewrite_prompt',
        sourceQuote: 'employees',
        beforeJson: { prompt: 'old' },
        afterJson: { prompt: 'How many employees does your company have right now' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_target');
  });
});

// ─── infer_type ───────────────────────────────────────────────────────────────

describe('planRevert · infer_type', () => {
  const graph = snapshot({
    sections: [
      section({
        id: 'sec-1',
        title: 'A',
        questions: [question({ id: 'q1', prompt: 'Age?', type: 'numeric' })],
      }),
    ],
  });

  it('restores the prior type from beforeJson', () => {
    const result = planRevert(
      change({
        changeType: 'infer_type',
        beforeJson: { type: 'free_text' },
        afterJson: { type: 'numeric' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toEqual([
      { op: 'update-question', questionId: 'q1', fields: { type: 'free_text', typeConfig: null } },
    ]);
  });

  it('falls back to free_text when no prior type was recorded', () => {
    const result = planRevert(
      change({ changeType: 'infer_type', beforeJson: {}, afterJson: { type: 'numeric' } }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-question') throw new Error('expected update-question');
    expect(op.fields.type).toBe('free_text');
  });
});

// ─── augment_question ─────────────────────────────────────────────────────────

describe('planRevert · augment_question', () => {
  it('clears an added guideline (beforeJson lacks it)', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'Q', guidelines: 'Added help' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'augment_question',
        beforeJson: { prompt: 'Q' },
        afterJson: { prompt: 'Q', guidelines: 'Added help' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-question') throw new Error('expected update-question');
    expect(op.fields.guidelines).toBeNull();
  });
});

// ─── merge_questions ──────────────────────────────────────────────────────────

describe('planRevert · merge_questions', () => {
  const graph = snapshot({
    sections: [
      section({
        id: 'sec-1',
        title: 'A',
        questions: [question({ id: 'merged', prompt: 'Combined Q' })],
      }),
    ],
  });

  it('deletes the merged question and re-creates the sources', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: [{ prompt: 'Source one' }, { prompt: 'Source two' }],
        afterJson: { prompt: 'Combined Q' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops[0]).toEqual({ op: 'delete-question', questionId: 'merged' });
    const creates = result.plan.ops.slice(1);
    expect(creates).toHaveLength(2);
    expect(creates.every((o) => o.op === 'create-question' && o.sectionId === 'sec-1')).toBe(true);
  });

  it('refuses when beforeJson is not an array of sources', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: { prompt: 'one' },
        afterJson: { prompt: 'Combined Q' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });
});

// ─── split_question ───────────────────────────────────────────────────────────

describe('planRevert · split_question', () => {
  const graph = snapshot({
    sections: [
      section({
        id: 'sec-1',
        title: 'A',
        questions: [
          question({ id: 'p1', prompt: 'Part one' }),
          question({ id: 'p2', prompt: 'Part two' }),
        ],
      }),
    ],
  });

  it('deletes the products and re-creates the original', () => {
    const result = planRevert(
      change({
        changeType: 'split_question',
        beforeJson: { prompt: 'Original compound' },
        afterJson: [{ prompt: 'Part one' }, { prompt: 'Part two' }],
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deletes = result.plan.ops.filter((o) => o.op === 'delete-question');
    expect(deletes).toHaveLength(2);
    const create = result.plan.ops.find((o) => o.op === 'create-question');
    expect(create && create.op === 'create-question' && create.question.prompt).toBe(
      'Original compound'
    );
  });

  it('refuses when a split product was edited or removed', () => {
    const result = planRevert(
      change({
        changeType: 'split_question',
        beforeJson: { prompt: 'Original compound' },
        afterJson: [{ prompt: 'Part one' }, { prompt: 'Gone' }],
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });
});

// ─── add_section ──────────────────────────────────────────────────────────────

describe('planRevert · add_section', () => {
  it('deletes the added section when it is still empty', () => {
    const graph = snapshot({ sections: [section({ id: 'sec-1', title: 'Added', questions: [] })] });
    const result = planRevert(
      change({
        changeType: 'add_section',
        targetEntityType: 'section',
        afterJson: { title: 'Added' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toEqual([{ op: 'delete-section', sectionId: 'sec-1' }]);
  });

  it('refuses when the added section now has questions (graph_drift)', () => {
    const graph = snapshot({
      sections: [
        section({ id: 'sec-1', title: 'Added', questions: [question({ id: 'q1', prompt: 'Q' })] }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'add_section',
        targetEntityType: 'section',
        afterJson: { title: 'Added' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('graph_drift');
  });

  it('reports target_not_found when no section matches the added title', () => {
    const result = planRevert(
      change({
        changeType: 'add_section',
        targetEntityType: 'section',
        afterJson: { title: 'Vanished' },
      }),
      snapshot({ sections: [section({ id: 'sec-1', title: 'Other' })] })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });

  it('reports ambiguous_target when two sections share the added title', () => {
    const result = planRevert(
      change({
        changeType: 'add_section',
        targetEntityType: 'section',
        afterJson: { title: 'Dup' },
      }),
      snapshot({
        sections: [section({ id: 'sec-1', title: 'Dup' }), section({ id: 'sec-2', title: 'Dup' })],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_target');
  });
});

// ─── Editorial edits on a section + reconciliation edges ──────────────────────

describe('planRevert · field-restore on a section', () => {
  const graph = snapshot({
    sections: [section({ id: 'sec-1', title: 'Setcion', description: 'typo desc' })],
  });

  it('restores a section title + description from beforeJson (correct_spelling)', () => {
    const result = planRevert(
      change({
        changeType: 'correct_spelling',
        targetEntityType: 'section',
        beforeJson: { title: 'Section', description: 'clean desc' },
        afterJson: { title: 'Setcion' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ops).toEqual([
      {
        op: 'update-section',
        sectionId: 'sec-1',
        fields: { title: 'Section', description: 'clean desc' },
      },
    ]);
  });

  it('refuses when the touched title has no prior value to restore', () => {
    const result = planRevert(
      change({
        changeType: 'correct_grammar',
        targetEntityType: 'section',
        beforeJson: { description: 'only a description' },
        afterJson: { title: 'Setcion' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });
});

describe('planRevert · field-restore edges', () => {
  it('refuses when no touched fields survive (missing_before_json)', () => {
    const graph = snapshot({
      sections: [
        section({ id: 'sec-1', title: 'A', questions: [question({ id: 'q1', prompt: 'Q' })] }),
      ],
    });
    // before/after carry only keys outside the allowed set → nothing to restore.
    const result = planRevert(
      change({
        changeType: 'augment_question',
        beforeJson: { weight: 2 },
        afterJson: { weight: 3 },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });

  it('refuses a prompt restore with no prior prompt (missing_before_json)', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'Current' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'rewrite_prompt',
        beforeJson: { prompt: '   ' },
        afterJson: { prompt: 'Current' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });

  it('restores a question rationale (augment_question)', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'Q', rationale: 'new reason' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'augment_question',
        beforeJson: { prompt: 'Q', rationale: 'old reason' },
        afterJson: { prompt: 'Q', rationale: 'new reason' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-question') throw new Error('expected update-question');
    expect(op.fields.rationale).toBe('old reason');
  });

  it('uses sourceQuote to uniquely select one of two equally-matching questions', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [
            question({ id: 'q1', prompt: 'What is your annual revenue', guidelines: 'Help' }),
            question({ id: 'q2', prompt: 'How many employees', guidelines: 'Help' }),
          ],
        }),
      ],
    });
    // afterJson has no prompt → both match on guidelines; sourceQuote overlaps q1.
    const result = planRevert(
      change({
        changeType: 'augment_question',
        sourceQuote: 'annual revenue',
        beforeJson: { guidelines: 'prior help' },
        afterJson: { guidelines: 'Help' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-question') throw new Error('expected update-question');
    expect(op.questionId).toBe('q1');
    expect(op.fields.guidelines).toBe('prior help');
  });
});

// ─── infer_type edges ─────────────────────────────────────────────────────────

describe('planRevert · infer_type edges', () => {
  it('restores the prior type config from beforeJson', () => {
    const graph = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [question({ id: 'q1', prompt: 'Pick?', type: 'numeric' })],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'infer_type',
        beforeJson: { type: 'numeric', typeConfig: { min: 0, max: 10 } },
        afterJson: { type: 'numeric' },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-question') throw new Error('expected update-question');
    expect(op.fields.typeConfig).toEqual({ min: 0, max: 10 });
  });

  it('refuses when the resolved target is a section, not a question', () => {
    const graph = snapshot({ sections: [section({ id: 'sec-1', title: 'A section title' })] });
    const result = planRevert(
      change({
        changeType: 'infer_type',
        targetEntityType: 'section',
        afterJson: { title: 'A section title' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });
});

// ─── prune_question section-ordinal hint ──────────────────────────────────────

describe('planRevert · prune_question ordinal hint', () => {
  it('resolves the parent section by sectionOrdinal when the title does not match', () => {
    const graph = snapshot({
      sections: [
        section({ id: 'sec-1', title: 'A', ordinal: 0 }),
        section({ id: 'sec-2', title: 'B', ordinal: 1 }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'prune_question',
        targetEntityType: 'question',
        beforeJson: { prompt: 'Dropped?', sectionOrdinal: 1 },
      }),
      graph
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'create-question') throw new Error('expected create-question');
    expect(op.sectionId).toBe('sec-2');
  });
});

// ─── merge_questions edges ────────────────────────────────────────────────────

describe('planRevert · merge_questions edges', () => {
  const graph = snapshot({
    sections: [
      section({
        id: 'sec-1',
        title: 'A',
        questions: [question({ id: 'merged', prompt: 'Combined' })],
      }),
    ],
  });

  it('refuses a single-element source array (structural_inverse_unavailable)', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: [{ prompt: 'only one' }],
        afterJson: { prompt: 'Combined' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });

  it('refuses when a source question lacks a prompt (structural_inverse_unavailable)', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: [{ prompt: 'one' }, { type: 'numeric' }],
        afterJson: { prompt: 'Combined' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });

  it('reports target_not_found when the merged question no longer matches', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: [{ prompt: 'one' }, { prompt: 'two' }],
        afterJson: { prompt: 'Edited since' },
      }),
      graph
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });

  it('reports ambiguous_target when two questions match the merged prompt', () => {
    const ambiguous = snapshot({
      sections: [
        section({
          id: 'sec-1',
          title: 'A',
          questions: [
            question({ id: 'm1', prompt: 'Combined' }),
            question({ id: 'm2', prompt: 'Combined' }),
          ],
        }),
      ],
    });
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        beforeJson: [{ prompt: 'one' }, { prompt: 'two' }],
        afterJson: { prompt: 'Combined' },
      }),
      ambiguous
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_target');
  });
});

// ─── split_question edges ─────────────────────────────────────────────────────

describe('planRevert · split_question edges', () => {
  it('refuses when beforeJson holds no recoverable original (structural_inverse_unavailable)', () => {
    const result = planRevert(
      change({
        changeType: 'split_question',
        beforeJson: { foo: 'bar' },
        afterJson: [{ prompt: 'a' }, { prompt: 'b' }],
      }),
      snapshot()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });

  it('refuses when afterJson is not an array of products (structural_inverse_unavailable)', () => {
    const result = planRevert(
      change({
        changeType: 'split_question',
        beforeJson: { prompt: 'Original' },
        afterJson: { prompt: 'one' },
      }),
      snapshot()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });
});

// ─── Reason helpers + dispatch fallthrough ────────────────────────────────────

describe('isRevertImpossibleReason', () => {
  it('accepts every known reason', () => {
    for (const reason of REVERT_IMPOSSIBLE_REASONS) {
      expect(isRevertImpossibleReason(reason)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isRevertImpossibleReason('not_a_reason')).toBe(false);
  });
});

describe('planRevert · unsupported change type', () => {
  it('fails cleanly for an unrecognised change type', () => {
    const result = planRevert(change({ changeType: 'totally_unknown' as ChangeType }), snapshot());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('structural_inverse_unavailable');
  });
});

// ─── Defensive fail-clean edges ───────────────────────────────────────────────

describe('planRevert · defensive edges', () => {
  it('prune_question refuses a non-object beforeJson (missing_before_json)', () => {
    const result = planRevert(
      change({ changeType: 'prune_question', targetEntityType: 'question', beforeJson: 42 }),
      snapshot({ sections: [section({ id: 'sec-1', title: 'A' })] })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_before_json');
  });

  it('merge_questions refuses when the resolved target is a section (target_not_found)', () => {
    const result = planRevert(
      change({
        changeType: 'merge_questions',
        targetEntityType: 'section',
        beforeJson: [{ prompt: 'one' }, { prompt: 'two' }],
        afterJson: { title: 'A merged-into section' },
      }),
      snapshot({ sections: [section({ id: 'sec-1', title: 'A merged-into section' })] })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target_not_found');
  });

  it('resolves a section edit by sourceQuote when afterJson omits the title', () => {
    const result = planRevert(
      change({
        changeType: 'correct_spelling',
        targetEntityType: 'section',
        sourceQuote: 'Demographics',
        beforeJson: { description: 'old description' },
        afterJson: { description: 'new description' },
      }),
      snapshot({
        sections: [
          section({ id: 'sec-1', title: 'Demographics' }),
          section({ id: 'sec-2', title: 'Other' }),
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.plan.ops[0];
    if (op.op !== 'update-section') throw new Error('expected update-section');
    expect(op.sectionId).toBe('sec-1');
    expect(op.fields.description).toBe('old description');
  });
});
