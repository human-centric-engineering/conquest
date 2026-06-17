/**
 * Unit tests for `buildPriorAnswersDigest` — the interviewer-continuity digest.
 *
 * Verifies the real selection logic: data-slot fills are preferred (paraphrase first), only
 * "covered" non-provisional fills count, the active target is excluded, the question-mode
 * fallback reads captured answers with a human label, and the digest stays capped.
 */

import { describe, expect, it } from 'vitest';

import { buildPriorAnswersDigest } from '@/app/api/v1/app/questionnaire-sessions/_lib/prior-answers';

const dataSlots = [
  { id: 'ds1', name: 'Housing' },
  { id: 'ds2', name: 'Budget' },
  { id: 'ds3', name: 'Timeline' },
];

describe('buildPriorAnswersDigest — data-slot mode', () => {
  it('renders covered, non-provisional fills as "name: paraphrase", excluding the active slot', () => {
    const digest = buildPriorAnswersDigest({
      dataSlots,
      dataSlotAnswered: [
        { dataSlotId: 'ds1', confidence: 0.9, paraphrase: 'rents a flat in Leeds' },
        { dataSlotId: 'ds2', confidence: 0.8, paraphrase: 'around £1200/month' },
        { dataSlotId: 'ds3', confidence: 0.95, paraphrase: 'wants to move in spring' },
      ],
      existingAnswers: [],
      questionPromptByKey: new Map(),
      excludeDataSlotId: 'ds3', // the one being asked right now
    });
    expect(digest).toEqual(['Housing: rents a flat in Leeds', 'Budget: around £1200/month']);
  });

  it('drops low-confidence fills, but keeps a plainly-stated (direct) one regardless of score', () => {
    const digest = buildPriorAnswersDigest({
      dataSlots,
      dataSlotAnswered: [
        { dataSlotId: 'ds1', confidence: 0.2, paraphrase: 'maybe renting?' }, // weak, not direct → drop
        { dataSlotId: 'ds2', confidence: 0.1, paraphrase: 'about £1200', provenance: 'direct' }, // stated → keep
      ],
      existingAnswers: [],
      questionPromptByKey: new Map(),
    });
    expect(digest).toEqual(['Budget: about £1200']);
  });

  it('excludes provisional (parked best-effort) fills — never echo something they did not say', () => {
    const digest = buildPriorAnswersDigest({
      dataSlots,
      dataSlotAnswered: [
        { dataSlotId: 'ds1', confidence: 0.9, paraphrase: 'inferred guess', provisional: true },
      ],
      existingAnswers: [],
      questionPromptByKey: new Map(),
    });
    expect(digest).toEqual([]);
  });

  it('falls back to a summarised value when a covered fill has no paraphrase', () => {
    const digest = buildPriorAnswersDigest({
      dataSlots,
      dataSlotAnswered: [{ dataSlotId: 'ds2', confidence: 0.9, value: 1200 }],
      existingAnswers: [],
      questionPromptByKey: new Map(),
    });
    expect(digest).toEqual(['Budget: 1200']);
  });

  it('caps the number of lines', () => {
    const manySlots = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Slot ${i}` }));
    const fills = manySlots.map((s) => ({
      dataSlotId: s.id,
      confidence: 0.9,
      paraphrase: `value ${s.id}`,
    }));
    const digest = buildPriorAnswersDigest({
      dataSlots: manySlots,
      dataSlotAnswered: fills,
      existingAnswers: [],
      questionPromptByKey: new Map(),
      limit: 5,
    });
    expect(digest).toHaveLength(5);
  });
});

describe('buildPriorAnswersDigest — question-mode fallback', () => {
  it('uses captured answers with the question prompt as the label, excluding the active question', () => {
    const digest = buildPriorAnswersDigest({
      dataSlots: [],
      dataSlotAnswered: [],
      existingAnswers: [
        { slotKey: 'q1', value: 'A nightmare', provenance: 'direct' },
        { slotKey: 'q2', value: 4, provenance: 'direct' },
        { slotKey: 'q3', value: 'should be hidden', provenance: 'direct' },
      ],
      questionPromptByKey: new Map([
        ['q1', 'How was setup?'],
        ['q2', 'Rate the docs'],
      ]),
      excludeQuestionKey: 'q3',
    });
    expect(digest).toEqual(['How was setup?: A nightmare', 'Rate the docs: 4']);
  });

  it('returns an empty digest when nothing has been captured', () => {
    expect(
      buildPriorAnswersDigest({
        dataSlots: [],
        dataSlotAnswered: [],
        existingAnswers: [],
        questionPromptByKey: new Map(),
      })
    ).toEqual([]);
  });
});
