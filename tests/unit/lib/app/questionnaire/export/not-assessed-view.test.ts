/**
 * Unit: the "what this interview did not cover" view — Conditional Topics (P17).
 *
 * The wording lives in a pure function precisely so it can be asserted here: the document that
 * renders it is React-PDF, which emits a binary buffer, and a claim this consequential must not be
 * covered only by a no-throw render test.
 *
 * @see lib/app/questionnaire/export/not-assessed-view.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildNotAssessedView,
  NOT_ASSESSED_NOTE,
} from '@/lib/app/questionnaire/export/not-assessed-view';
import type { NotAssessedTopic } from '@/lib/app/questionnaire/scope/types';

function topic(over: Partial<NotAssessedTopic> = {}): NotAssessedTopic {
  return { key: 'pricing', label: 'Pricing', questionCount: 4, partial: false, ...over };
}

describe('buildNotAssessedView', () => {
  it('is empty for a session that assessed everything', () => {
    // The overwhelmingly common case: a non-adaptive session, where the document must say nothing
    // at all rather than print an empty heading implying something was left out.
    expect(buildNotAssessedView([])).toEqual({ skipped: [], sampled: [] });
  });

  it('keeps "we did not look" apart from "we looked lightly"', () => {
    const view = buildNotAssessedView([
      topic({ key: 'pricing', label: 'Pricing', questionCount: 4 }),
      topic({ key: 'talent', label: 'Talent', questionCount: 6, partial: true }),
    ]);

    expect(view.skipped).toEqual(['Pricing — 4 questions']);
    expect(view.sampled).toEqual(['Talent — 6 questions']);
  });

  it('names how many questions each area cost, not just the area', () => {
    // "Pricing" alone does not tell a reader whether the omission matters to them.
    const view = buildNotAssessedView([topic({ questionCount: 12 })]);
    expect(view.skipped[0]).toBe('Pricing — 12 questions');
  });

  it('says "1 question" rather than "1 questions"', () => {
    expect(buildNotAssessedView([topic({ questionCount: 1 })]).skipped[0]).toBe(
      'Pricing — 1 question'
    );
  });

  it('preserves the order the session export built', () => {
    // Authored topic order. A list that re-sorted itself would not match the section order the
    // reader has just read past.
    const view = buildNotAssessedView([
      topic({ key: 'a', label: 'Alpha' }),
      topic({ key: 'b', label: 'Beta' }),
      topic({ key: 'c', label: 'Gamma' }),
    ]);
    expect(view.skipped).toEqual([
      'Alpha — 4 questions',
      'Beta — 4 questions',
      'Gamma — 4 questions',
    ]);
  });

  it('tells the reader a missing question was never asked, not skipped', () => {
    // The distinction the whole section exists for — and the one a reader gets wrong by default.
    expect(NOT_ASSESSED_NOTE).toContain('never asked');
    expect(NOT_ASSESSED_NOTE).toContain('rather than skipped');
  });
});
