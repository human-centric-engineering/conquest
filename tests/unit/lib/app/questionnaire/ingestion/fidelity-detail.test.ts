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
  hasFidelityFindings,
  readFidelityDetail,
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

/* -------------------------------------------------------------------------- */

/**
 * The reader.
 *
 * Anti-green-bar: the cases that matter are the DEGRADED ones. This parses a `Json` column written
 * by an older build, and the wrong failure mode is not a crash — it is returning nothing, which
 * renders identically to a clean extraction. Every test below is a shape some real row already
 * has or will have.
 */
describe('readFidelityDetail', () => {
  const CHECKED_AT = new Date('2026-08-20T10:30:00.000Z');

  /** A row as the current writer produces it. */
  function row(detail: unknown, outputSnapshot: unknown = [], status = 'succeeded') {
    return { detail, outputSnapshot, status, createdAt: CHECKED_AT };
  }

  it('reads a current row whole', () => {
    const detail = buildFidelityDetail({
      flaggedCount: 2,
      totalCount: 22,
      repairOutcome: 'repaired',
      coverage: { sourceQuestionCount: 22, assessment: 'matches' },
      disallowedEditCount: 0,
      unattributedPromptKeys: ['register_owner'],
      fileName: 'instrument.docx',
    });

    const view = readFidelityDetail(
      row(detail, [
        {
          key: 'register_owner',
          verdict: 'suspect',
          issue: 'type_mismatch',
          detail: 'Looks likert.',
        },
        { key: 'name', verdict: 'ok' },
      ])
    );

    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      totalCount: 22,
      flaggedCount: 2,
      repairOutcome: 'repaired',
      unattributedPromptKeys: ['register_owner'],
      unattributedPromptCount: 1,
      fileName: 'instrument.docx',
      verifierUnavailable: false,
      checkedAt: '2026-08-20T10:30:00.000Z',
    });
    // Only the suspect verdicts, carrying the critic's reason.
    expect(view?.flagged).toEqual([
      { key: 'register_owner', issue: 'type_mismatch', detail: 'Looks likert.' },
    ]);
  });

  it('reports a legacy row that stored a count and no keys, rather than reading as clean', () => {
    // Written before the check returned keys. Silently dropping to zero would tell an admin the
    // extraction was faithful when the row says two prompts were not.
    const view = readFidelityDetail(
      row({
        flaggedCount: 0,
        totalCount: 18,
        repairOutcome: 'none_flagged',
        unattributedPromptCount: 2,
        fileName: 'old.pdf',
      })
    );

    expect(view?.unattributedPromptCount).toBe(2);
    expect(view?.unattributedPromptKeys).toEqual([]);
    expect(hasFidelityFindings(view!)).toBe(true);
  });

  it('reads a row from before the coverage dimension existed', () => {
    const view = readFidelityDetail(
      row({ flaggedCount: 1, totalCount: 9, repairOutcome: 'repaired', fileName: 'v1.md' })
    );

    expect(view?.coverage).toBeNull();
    expect(view?.flaggedCount).toBe(1);
  });

  it('keeps the recorded flagged count when the output snapshot is missing', () => {
    // The store caps snapshots and marks them truncated, so a long questionnaire's verdicts can be
    // gone while the count survives. Deriving the count from the list would report it as clean.
    const view = readFidelityDetail(
      row({ flaggedCount: 3, totalCount: 140, repairOutcome: 'repaired' }, null)
    );

    expect(view?.flaggedCount).toBe(3);
    expect(view?.flagged).toEqual([]);
    expect(hasFidelityFindings(view!)).toBe(true);
  });

  it('survives a malformed field instead of discarding the row', () => {
    const view = readFidelityDetail(
      row({
        flaggedCount: 'two',
        totalCount: 22,
        repairOutcome: 'exploded',
        coverage: { assessment: 'not-a-verdict' },
        unattributedPromptKeys: 'register_owner',
        fileName: 'instrument.docx',
      })
    );

    // The good fields still render; the bad ones degrade to empty rather than blanking the panel.
    expect(view?.totalCount).toBe(22);
    expect(view?.fileName).toBe('instrument.docx');
    expect(view?.flaggedCount).toBe(0);
    expect(view?.repairOutcome).toBe('none_flagged');
    expect(view?.coverage).toBeNull();
    expect(view?.unattributedPromptKeys).toEqual([]);
  });

  it('returns null only when the detail is not an object at all', () => {
    expect(readFidelityDetail(row(null))).toBeNull();
    expect(readFidelityDetail(row('nope'))).toBeNull();
  });

  it('marks the verifier unavailable from either the outcome or a failed row status', () => {
    const byOutcome = readFidelityDetail(
      row({ flaggedCount: 0, totalCount: 0, repairOutcome: 'verifier_unavailable' })
    );
    const byStatus = readFidelityDetail(
      row({ flaggedCount: 0, totalCount: 0, repairOutcome: 'none_flagged' }, [], 'failed')
    );

    expect(byOutcome?.verifierUnavailable).toBe(true);
    expect(byStatus?.verifierUnavailable).toBe(true);
  });
});

describe('hasFidelityFindings', () => {
  function view(over: Partial<ReturnType<typeof readFidelityDetail>> = {}) {
    const base = readFidelityDetail({
      detail: buildFidelityDetail({
        flaggedCount: 0,
        totalCount: 22,
        repairOutcome: 'none_flagged',
        coverage: { sourceQuestionCount: 22, assessment: 'matches' },
        disallowedEditCount: 0,
        unattributedPromptKeys: [],
        fileName: 'clean.docx',
      }),
      outputSnapshot: [],
      status: 'succeeded',
      createdAt: new Date('2026-08-20T10:30:00.000Z'),
    })!;
    return { ...base, ...over };
  }

  it('says nothing on a clean extraction', () => {
    // The band renders only on `true`, so this is what keeps an all-good panel off the screen.
    expect(hasFidelityFindings(view())).toBe(false);
  });

  it('says nothing when the source cannot be counted', () => {
    // `uncountable` is the common and correct answer for an instrument that does not number its
    // questions. Treating it as a finding would put an amber panel on most clean ingests.
    expect(
      hasFidelityFindings(
        view({ coverage: { sourceQuestionCount: null, assessment: 'uncountable' } })
      )
    ).toBe(false);
  });

  it('speaks up on a count mismatch, a flag, an unattributed prompt, or a check that never ran', () => {
    expect(
      hasFidelityFindings(
        view({ coverage: { sourceQuestionCount: 22, assessment: 'missing_questions' } })
      )
    ).toBe(true);
    expect(hasFidelityFindings(view({ flaggedCount: 1 }))).toBe(true);
    expect(hasFidelityFindings(view({ unattributedPromptCount: 1 }))).toBe(true);
    expect(hasFidelityFindings(view({ verifierUnavailable: true }))).toBe(true);
  });

  it('stays quiet for a disallowed edit alone — that is a build signal, not an admin one', () => {
    // Nothing an admin can do about "the extractor split a question against instruction", so a
    // panel raised only by it would be unactionable noise.
    expect(hasFidelityFindings(view({ disallowedEditCount: 4 }))).toBe(false);
  });
});
