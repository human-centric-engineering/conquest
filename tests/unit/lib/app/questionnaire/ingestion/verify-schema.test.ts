/**
 * The extraction verifier's output contract.
 *
 * Weighted towards `coverage`, the newest field and the one carrying the most product weight: it is
 * the only part of this contract that can see a wrong question SET rather than a wrong question.
 * Its optionality is load-bearing and easy to "tidy" away, which is what these tests are guarding.
 */

import { describe, it, expect } from 'vitest';

import {
  validateVerifyResult,
  verifyJsonSchema,
  VERIFY_ISSUES,
} from '@/lib/app/questionnaire/ingestion/verify-schema';

const OK_VERDICTS = [{ key: 'q1', verdict: 'ok' }];

describe('validateVerifyResult — verdicts', () => {
  it('accepts a minimal reply and defaults matrixGroups', () => {
    const res = validateVerifyResult({ verdicts: OK_VERDICTS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.matrixGroups).toEqual([]);
  });

  it('accepts every declared issue on a suspect verdict', () => {
    for (const issue of VERIFY_ISSUES) {
      const res = validateVerifyResult({
        verdicts: [{ key: 'q1', verdict: 'suspect', issue, detail: 'why' }],
      });
      expect(res.ok, `issue "${issue}" was rejected`).toBe(true);
    }
  });

  it('rejects a verdict value outside the vocabulary', () => {
    expect(validateVerifyResult({ verdicts: [{ key: 'q1', verdict: 'maybe' }] }).ok).toBe(false);
  });
});

describe('validateVerifyResult — coverage', () => {
  // Optional ON PURPOSE. The whole ingest chain is fail-soft, and a critic reply that omits
  // coverage still carries per-question verdicts worth having — discarding them because one newer
  // field is missing would trade a real result for nothing. "Not assessed" is not "invalid".
  it('accepts a reply with no coverage at all', () => {
    const res = validateVerifyResult({ verdicts: OK_VERDICTS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.coverage).toBeUndefined();
  });

  it('accepts each assessment the critic may return', () => {
    const cases = [
      { sourceQuestionCount: 22, assessment: 'matches' },
      { sourceQuestionCount: 22, assessment: 'extra_questions', detail: 'q3 looks invented' },
      { sourceQuestionCount: 30, assessment: 'missing_questions', detail: 'section 4 absent' },
      { sourceQuestionCount: null, assessment: 'uncountable' },
    ];
    for (const coverage of cases) {
      const res = validateVerifyResult({ verdicts: OK_VERDICTS, coverage });
      expect(res.ok, `${coverage.assessment} was rejected`).toBe(true);
    }
  });

  // `uncountable` has to be expressible, or the critic is cornered into inventing a number for
  // every unnumbered instrument — which would make each of them look like a coverage failure.
  it('allows a null count, which is what uncountable means', () => {
    const res = validateVerifyResult({
      verdicts: OK_VERDICTS,
      coverage: { sourceQuestionCount: null, assessment: 'uncountable' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.coverage?.sourceQuestionCount).toBeNull();
  });

  it('rejects an assessment outside the vocabulary', () => {
    const res = validateVerifyResult({
      verdicts: OK_VERDICTS,
      coverage: { sourceQuestionCount: 5, assessment: 'probably_fine' },
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a negative or fractional source count', () => {
    for (const sourceQuestionCount of [-1, 2.5]) {
      const res = validateVerifyResult({
        verdicts: OK_VERDICTS,
        coverage: { sourceQuestionCount, assessment: 'matches' },
      });
      expect(res.ok, `count ${sourceQuestionCount} was accepted`).toBe(false);
    }
  });

  // The count is missing rather than optional: a coverage block that cannot say how many questions
  // the source has is not an assessment, it is a shrug wearing one. `uncountable` is how the critic
  // says that, explicitly, with a null.
  it('rejects a coverage block that omits the count entirely', () => {
    const res = validateVerifyResult({
      verdicts: OK_VERDICTS,
      coverage: { assessment: 'matches' },
    });
    expect(res.ok).toBe(false);
  });
});

describe('verifyJsonSchema', () => {
  it('serialises coverage so a provider can be constrained to the shape', () => {
    const properties = verifyJsonSchema.properties as Record<string, unknown>;
    const coverage = properties.coverage as Record<string, unknown>;

    expect(Object.keys(coverage.properties as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['sourceQuestionCount', 'assessment'])
    );
  });

  it('leaves coverage out of the required set', () => {
    // Mirrors the optionality above: the wire contract must not demand a field the parse contract
    // is willing to do without, or an older verifier reply becomes a hard failure.
    expect(verifyJsonSchema.required as string[]).not.toContain('coverage');
  });
});
