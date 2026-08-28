/**
 * The `extraction_verify` provenance `detail` writer.
 *
 * Anti-green-bar: these assert the SHAPE THAT REACHES THE ROW, key by key, rather than that the
 * builder returns an object. The reason is the specific failure this module exists to prevent —
 * the block was duplicated in two stream routes and a field added to it landed in only one, which
 * on a provenance row is indistinguishable from an ingest that had nothing to report. The
 * omit-when-empty behaviour is therefore not a cosmetic detail but the reader's contract: a
 * present key means something happened.
 *
 * @see lib/app/questionnaire/ingestion/fidelity-detail.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildFidelityDetail,
  type FidelityDetailInput,
} from '@/lib/app/questionnaire/ingestion/fidelity-detail';

/** A clean ingest: critic ran, flagged nothing, no whole-set signal to report. */
function cleanInput(overrides: Partial<FidelityDetailInput> = {}): FidelityDetailInput {
  return {
    flaggedCount: 0,
    totalCount: 22,
    repairOutcome: 'none_flagged',
    coverage: null,
    disallowedEditCount: 0,
    unattributedPromptKeys: [],
    fileName: 'instrument.docx',
    ...overrides,
  };
}

describe('buildFidelityDetail', () => {
  it('always carries the run-level facts, so a row can be read without the extraction', () => {
    const detail = buildFidelityDetail(cleanInput({ flaggedCount: 3, repairOutcome: 'repaired' }));

    expect(detail).toMatchObject({
      flaggedCount: 3,
      totalCount: 22,
      repairOutcome: 'repaired',
      fileName: 'instrument.docx',
    });
  });

  it('omits all three whole-set signals on a clean ingest', () => {
    const detail = buildFidelityDetail(cleanInput());

    // Absent, not zero. The admin surface renders "nothing to report" by finding no key, so a
    // zero written here would read as a signal that fired and measured nothing.
    expect(detail).not.toHaveProperty('coverage');
    expect(detail).not.toHaveProperty('disallowedEditCount');
    expect(detail).not.toHaveProperty('unattributedPromptCount');
    expect(detail).not.toHaveProperty('unattributedPromptKeys');
  });

  it('carries the coverage read whole, including an uncountable verdict', () => {
    // `uncountable` is a real answer — most instruments do not number their questions — so it must
    // survive to the row rather than being folded into "no coverage read".
    const detail = buildFidelityDetail(
      cleanInput({
        coverage: { sourceQuestionCount: null, assessment: 'uncountable' },
      })
    );

    expect(detail.coverage).toEqual({ sourceQuestionCount: null, assessment: 'uncountable' });
  });

  it('carries a count mismatch with the detail line that explains it', () => {
    const detail = buildFidelityDetail(
      cleanInput({
        coverage: {
          sourceQuestionCount: 22,
          assessment: 'extra_questions',
          detail: 'Q7 appears to be a heading promoted to a question.',
        },
      })
    );

    expect(detail.coverage).toEqual({
      sourceQuestionCount: 22,
      assessment: 'extra_questions',
      detail: 'Q7 appears to be a heading promoted to a question.',
    });
  });

  it('writes the unattributed keys AND a count derived from them', () => {
    const detail = buildFidelityDetail(
      cleanInput({ unattributedPromptKeys: ['pedestrian_plant', 'register_owner'] })
    );

    expect(detail.unattributedPromptKeys).toEqual(['pedestrian_plant', 'register_owner']);
    // Derived, never carried separately: a corpus run reads the count and an admin reads the keys,
    // and two independently-tracked fields describing one list eventually disagree.
    expect(detail.unattributedPromptCount).toBe(2);
  });

  it('reports disallowed edits when the extractor split or merged anyway', () => {
    const detail = buildFidelityDetail(cleanInput({ disallowedEditCount: 6 }));

    expect(detail.disallowedEditCount).toBe(6);
  });

  it('reports each signal independently — one firing does not summon the others', () => {
    // The three answer different questions (is the SET right / did it edit against instruction /
    // is the wording the author's). A run can trip exactly one, and the row must say only that.
    const detail = buildFidelityDetail(cleanInput({ disallowedEditCount: 1 }));

    expect(detail).toHaveProperty('disallowedEditCount');
    expect(detail).not.toHaveProperty('coverage');
    expect(detail).not.toHaveProperty('unattributedPromptKeys');
  });
});
