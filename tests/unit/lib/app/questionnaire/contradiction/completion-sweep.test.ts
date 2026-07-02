import { describe, expect, it } from 'vitest';

import { filterSweepFindings } from '@/lib/app/questionnaire/contradiction/completion-sweep';
import type { RaisedContradiction } from '@/lib/app/questionnaire/contradiction/types';

import { finding } from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

const raised = (
  slotKeys: string[],
  resolution: RaisedContradiction['resolution']
): RaisedContradiction => ({
  key: [...slotKeys].sort().join('|'),
  slotKeys,
  resolution,
  raisedAtTurnIndex: 0,
});

describe('filterSweepFindings', () => {
  it('surfaces a genuinely new conflict (not in the ledger)', () => {
    const out = filterSweepFindings([finding({ slotKeys: ['a', 'b'] })], []);
    expect(out).toHaveLength(1);
    expect(out[0]?.slotKeys).toEqual(['a', 'b']);
  });

  it('surfaces a still-unresolved conflict as the final check', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['a', 'b'] })],
      [raised(['a', 'b'], 'unresolved')]
    );
    expect(out).toHaveLength(1);
  });

  it('drops a below-floor (low-confidence) finding — a hedged guess never holds the submit', () => {
    // A 0.6-confidence "could imply" finding is below the surfacing floor (0.7), so the final check
    // does not raise it even though it is brand-new. (The exact false positive from BBG4-NZCN.)
    const out = filterSweepFindings([finding({ slotKeys: ['a', 'b'], confidence: 0.6 })], []);
    expect(out).toEqual([]);
  });

  it('keeps a finding exactly at the floor (0.7)', () => {
    const out = filterSweepFindings([finding({ slotKeys: ['a', 'b'], confidence: 0.7 })], []);
    expect(out).toHaveLength(1);
  });

  it('suppresses a conflict already resolved mid-conversation', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['a', 'b'] })],
      [raised(['a', 'b'], 'resolved')]
    );
    expect(out).toEqual([]);
  });

  it('suppresses a conflict the respondent explicitly kept', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['a', 'b'] })],
      [raised(['a', 'b'], 'kept')]
    );
    expect(out).toEqual([]);
  });

  it('suppresses a flag-mode conflict already surfaced', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['a', 'b'] })],
      [raised(['a', 'b'], 'flagged')]
    );
    expect(out).toEqual([]);
  });

  it('matches ledger identity regardless of slot-key order', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['b', 'a'] })],
      [raised(['a', 'b'], 'resolved')]
    );
    expect(out).toEqual([]); // ['b','a'] canonicalises to 'a|b'
  });

  it('keeps only the survivors from a mixed batch', () => {
    const out = filterSweepFindings(
      [
        finding({ slotKeys: ['a'], explanation: 'new' }),
        finding({ slotKeys: ['b'], explanation: 'resolved earlier' }),
        finding({ slotKeys: ['c'], explanation: 'unresolved earlier' }),
      ],
      [raised(['b'], 'resolved'), raised(['c'], 'unresolved')]
    );
    expect(out.map((f) => f.explanation)).toEqual(['new', 'unresolved earlier']);
  });

  it('returns an empty array when everything was already dealt with', () => {
    const out = filterSweepFindings(
      [finding({ slotKeys: ['a'] }), finding({ slotKeys: ['b'] })],
      [raised(['a'], 'resolved'), raised(['b'], 'kept')]
    );
    expect(out).toEqual([]);
  });
});
