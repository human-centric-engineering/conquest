/**
 * The ingest repair merge guard — the "never worse" core of the verify+repair pass.
 *
 * @see app/api/v1/app/questionnaires/_lib/orchestrate-extraction.ts (mergeRepairs)
 */

import { describe, it, expect, vi } from 'vitest';

// The module imports the Prisma client at top level (for the agent loads elsewhere in the file);
// mergeRepairs itself is pure, so a bare stub is enough to import it.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { mergeRepairs } from '@/app/api/v1/app/questionnaires/_lib/orchestrate-extraction';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { RepairResult } from '@/lib/app/questionnaire/ingestion/repair-schema';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function q(key: string, type: string, config: unknown, ordinal = 0): ExtractedQuestion {
  return {
    sectionOrdinal: ordinal,
    key,
    prompt: `Prompt for ${key}`,
    suggestedType: type as ExtractedQuestion['suggestedType'],
    suggestedTypeConfig: config as Record<string, unknown>,
    extractionConfidence: 0.6,
  };
}

function extraction(questions: ExtractedQuestion[]): ExtractQuestionnaireStructureData {
  return { sections: [{ ordinal: 0, title: 'Section' }], questions, changes: [] };
}

const goodLikert = { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' };

describe('mergeRepairs', () => {
  it('returns the extraction unchanged when there are no repairs', () => {
    const ex = extraction([q('q1', 'likert', goodLikert)]);
    expect(mergeRepairs(ex, { repairs: [] }, log)).toBe(ex);
  });

  it('applies a valid correct: replaces the question in place + records a change', () => {
    const ex = extraction([q('q1', 'multi_choice', { choices: [{ value: 'a', label: 'A' }] })]);
    const repairs: RepairResult = {
      repairs: [
        { originalKeys: ['q1'], action: 'correct', questions: [q('q1', 'likert', goodLikert)] },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    expect(merged.questions).toHaveLength(1);
    expect(merged.questions[0].suggestedType).toBe('likert');
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0].changeType).toBe('infer_type');
  });

  it('rejects a correct whose config fails the write schema (keeps the original)', () => {
    const original = q('q1', 'likert', goodLikert);
    const ex = extraction([original]);
    // Candidate likert has no labels/anchors → invalid write config → must be rejected.
    const repairs: RepairResult = {
      repairs: [
        {
          originalKeys: ['q1'],
          action: 'correct',
          questions: [q('q1', 'likert', { min: 1, max: 5 })],
        },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    expect(merged.questions[0]).toEqual(original);
    expect(merged.changes).toHaveLength(0);
  });

  it('rejects a correct that changed the key (keeps the original)', () => {
    const ex = extraction([q('q1', 'multi_choice', { choices: [{ value: 'a', label: 'A' }] })]);
    const repairs: RepairResult = {
      repairs: [
        {
          originalKeys: ['q1'],
          action: 'correct',
          questions: [q('q_renamed', 'likert', goodLikert)],
        },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    expect(merged.questions[0].key).toBe('q1');
    expect(merged.questions[0].suggestedType).toBe('multi_choice');
    expect(merged.changes).toHaveLength(0);
  });

  it('applies a valid merge: N rows → one matrix at the first row position', () => {
    const ex = extraction([
      q('row_fuel', 'likert', goodLikert),
      q('row_reliability', 'likert', goodLikert),
      q('other', 'free_text', null),
    ]);
    const matrix = q('importance', 'matrix', {
      rows: [
        { key: 'fuel', label: 'Fuel' },
        { key: 'reliability', label: 'Reliability' },
      ],
      scale: goodLikert,
    });
    const repairs: RepairResult = {
      repairs: [
        { originalKeys: ['row_fuel', 'row_reliability'], action: 'merge', questions: [matrix] },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    // The two rows collapse to one matrix at the first row's position; 'other' is untouched.
    expect(merged.questions.map((x) => x.suggestedType)).toEqual(['matrix', 'free_text']);
    expect(merged.questions[0].key).toBe('importance');
    expect(merged.changes[0].changeType).toBe('merge_questions');
  });

  it('rejects a merge that produces an invalid matrix (keeps the originals)', () => {
    const ex = extraction([q('row_a', 'likert', goodLikert), q('row_b', 'likert', goodLikert)]);
    // Matrix with an unlabelled scale → invalid write config.
    const badMatrix = q('grid', 'matrix', {
      rows: [{ key: 'a', label: 'A' }],
      scale: { min: 1, max: 5 },
    });
    const repairs: RepairResult = {
      repairs: [{ originalKeys: ['row_a', 'row_b'], action: 'merge', questions: [badMatrix] }],
    };
    const merged = mergeRepairs(ex, repairs, log);
    expect(merged.questions.map((x) => x.key)).toEqual(['row_a', 'row_b']);
    expect(merged.changes).toHaveLength(0);
  });

  // Regression: the merge anchor must be the first RESOLVED row, not `originalKeys[0]`. When the
  // model's first listed key is stale/hallucinated (absent from the extraction) but later keys are
  // valid, the matrix must still be inserted and the real rows preserved — never silently dropped.
  it('merges when the first originalKey is stale but ≥2 later keys resolve (keeps the matrix)', () => {
    const ex = extraction([
      q('row_fuel', 'likert', goodLikert),
      q('row_reliability', 'likert', goodLikert),
      q('other', 'free_text', null),
    ]);
    const matrix = q('importance', 'matrix', {
      rows: [
        { key: 'fuel', label: 'Fuel' },
        { key: 'reliability', label: 'Reliability' },
      ],
      scale: goodLikert,
    });
    const repairs: RepairResult = {
      repairs: [
        {
          // 'ghost_row' does not exist in the extraction; the two real rows follow it.
          originalKeys: ['ghost_row', 'row_fuel', 'row_reliability'],
          action: 'merge',
          questions: [matrix],
        },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    // The matrix is inserted at the first resolved row's position; both real rows collapse into it.
    expect(merged.questions.map((x) => x.suggestedType)).toEqual(['matrix', 'free_text']);
    expect(merged.questions.map((x) => x.key)).toEqual(['importance', 'other']);
    expect(merged.changes).toHaveLength(1);
  });

  // Regression: a row already merged into one matrix must not be merged into a second — no row may
  // appear in two persisted matrices.
  it('does not merge a row that an earlier repair already consumed', () => {
    const ex = extraction([
      q('row_a', 'likert', goodLikert),
      q('row_b', 'likert', goodLikert),
      q('row_c', 'likert', goodLikert),
    ]);
    const first = q('grid_1', 'matrix', {
      rows: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      scale: goodLikert,
    });
    const second = q('grid_2', 'matrix', {
      rows: [
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      scale: goodLikert,
    });
    const repairs: RepairResult = {
      repairs: [
        { originalKeys: ['row_a', 'row_b'], action: 'merge', questions: [first] },
        // 'row_b' is already consumed → only 'row_c' resolves → < 2 → this merge is skipped.
        { originalKeys: ['row_b', 'row_c'], action: 'merge', questions: [second] },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    // Only the first matrix lands; row_c stays as its original likert; no duplicate row_b.
    expect(merged.questions.map((x) => x.key)).toEqual(['grid_1', 'row_c']);
    expect(merged.changes).toHaveLength(1);
  });

  // Regression: a `correct` targeting a key an earlier merge already removed must not record a
  // discarded change (the merged-away question no longer exists in the output).
  it('skips a correct whose key was already merged away (no orphan change record)', () => {
    const ex = extraction([q('row_a', 'likert', goodLikert), q('row_b', 'likert', goodLikert)]);
    const matrix = q('grid', 'matrix', {
      rows: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      scale: goodLikert,
    });
    const repairs: RepairResult = {
      repairs: [
        { originalKeys: ['row_a', 'row_b'], action: 'merge', questions: [matrix] },
        // row_a was merged away; a later 'correct' on it must be ignored.
        { originalKeys: ['row_a'], action: 'correct', questions: [q('row_a', 'numeric', {})] },
      ],
    };
    const merged = mergeRepairs(ex, repairs, log);
    expect(merged.questions.map((x) => x.key)).toEqual(['grid']);
    // Exactly one change (the merge); no discarded 'correct' entry for the vanished row.
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0].changeType).toBe('merge_questions');
  });
});
