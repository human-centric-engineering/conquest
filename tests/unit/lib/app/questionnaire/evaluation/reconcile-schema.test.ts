/**
 * Unit test: the cross-judge reconciliation contract.
 *
 * The schema is the only thing standing between a model's free text and a suggestion an admin may
 * apply to a live questionnaire, so the cases here are the ones that would let something through:
 * an alternative that claims nothing, more alternatives than the contract allows, an unknown
 * dimension name, and a stored blob that has rotted since it was written.
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_ALTERNATIVES_PER_TARGET,
  parseReconciledSuggestions,
  validateReconcileResult,
} from '@/lib/app/questionnaire/evaluation/reconcile-schema';

const ALTERNATIVE = {
  prompt: 'How would you describe your current workload?',
  addresses: ['clarity', 'audience_match'],
  note: 'Single ask, no jargon.',
};

const SUGGESTION = {
  targetKey: 'q_workload',
  alternatives: [ALTERNATIVE],
  unresolved: ['type_fit'],
};

describe('validateReconcileResult', () => {
  it('accepts a well-formed reconciliation', () => {
    const result = validateReconcileResult({ reconciliations: [SUGGESTION] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reconciliations[0].targetKey).toBe('q_workload');
    expect(result.value.reconciliations[0].alternatives[0].addresses).toEqual([
      'clarity',
      'audience_match',
    ]);
  });

  it('defaults `unresolved` to empty when the model omits it', () => {
    // The common case is that the alternatives cover everything, and a model that says nothing
    // about `unresolved` means exactly that — it should not fail validation over an absent field.
    const result = validateReconcileResult({
      reconciliations: [{ targetKey: 'q_workload', alternatives: [ALTERNATIVE] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reconciliations[0].unresolved).toEqual([]);
  });

  it('rejects an alternative that addresses no dimension', () => {
    // A phrasing that resolves nothing is not an alternative — it is a rewrite for its own sake,
    // and rendering it would tell the admin a judge was satisfied when none was.
    const result = validateReconcileResult({
      reconciliations: [
        { targetKey: 'q_workload', alternatives: [{ ...ALTERNATIVE, addresses: [] }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.join('.').includes('addresses'))).toBe(true);
  });

  it('rejects more alternatives than the contract allows', () => {
    const tooMany = Array.from({ length: MAX_ALTERNATIVES_PER_TARGET + 1 }, () => ALTERNATIVE);
    const result = validateReconcileResult({
      reconciliations: [{ targetKey: 'q_workload', alternatives: tooMany }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a dimension name the panel does not have', () => {
    // The reconciler is told to use only the dimensions it was given; this makes that true, so a
    // hallucinated judge name can never reach the pack or the review queue.
    const result = validateReconcileResult({
      reconciliations: [
        { targetKey: 'q_workload', alternatives: [{ ...ALTERNATIVE, addresses: ['vibes'] }] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('names the invalid field path so the repair retry can be specific', () => {
    const result = validateReconcileResult({
      reconciliations: [{ targetKey: '', alternatives: [ALTERNATIVE] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path.join('.')).join(' ')).toContain('targetKey');
  });
});

describe('parseReconciledSuggestions', () => {
  it('reads a well-formed stored list', () => {
    expect(parseReconciledSuggestions([SUGGESTION])).toHaveLength(1);
  });

  it('treats a null column as "never reconciled", not an error', () => {
    // Every run written before this column existed reads as null. That is a true statement about
    // the run, not missing data to backfill — consumers fall back to the judges' own suggestions.
    expect(parseReconciledSuggestions(null)).toEqual([]);
    expect(parseReconciledSuggestions(undefined)).toEqual([]);
  });

  it('degrades a malformed blob to empty rather than throwing', () => {
    // A stored JSON column is never trusted on the way out: a rotted blob must cost the reader the
    // alternatives, not the whole run detail page.
    expect(parseReconciledSuggestions({ not: 'an array' })).toEqual([]);
    expect(parseReconciledSuggestions([{ targetKey: 'q1' }])).toEqual([]);
    expect(parseReconciledSuggestions('[]')).toEqual([]);
  });
});
