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
});
