import { describe, expect, it } from 'vitest';

import { ANSWER_PROVENANCES, EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';

/**
 * The answer-extraction contract derives its `provenance` enum from
 * `EXTRACTOR_EMITTED_PROVENANCES`, a deliberate subset of the full
 * `ANSWER_PROVENANCES` vocabulary. These assertions pin the relationship so a
 * change to either tuple (e.g. F4.4 wiring `refined`) is a conscious, tested one.
 */
describe('answer-provenance vocabulary parity', () => {
  it('the emittable set is a strict subset of the full vocabulary', () => {
    const full = new Set<string>(ANSWER_PROVENANCES);
    for (const label of EXTRACTOR_EMITTED_PROVENANCES) {
      expect(full.has(label), `"${label}" must be in ANSWER_PROVENANCES`).toBe(true);
    }
    expect(EXTRACTOR_EMITTED_PROVENANCES.length).toBeLessThan(ANSWER_PROVENANCES.length);
  });

  it('refined is reserved (in the vocabulary, not emittable by the F4.2 extractor)', () => {
    expect(ANSWER_PROVENANCES).toContain('refined');
    expect([...EXTRACTOR_EMITTED_PROVENANCES]).not.toContain('refined');
  });

  it('the full vocabulary is exactly the four planned labels', () => {
    expect([...ANSWER_PROVENANCES].sort()).toEqual(
      ['direct', 'inferred', 'refined', 'synthesised'].sort()
    );
  });
});
