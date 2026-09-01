/**
 * `narrowSectionedInterviewSettings` — the read path for the `sections` config blob.
 *
 * The one behaviour worth guarding hardest is the failure direction: a blob this narrower cannot
 * read must come back with the feature OFF. It decides how a respondent moves through an
 * instrument, and a half-read blob that left someone bounded to a section by a rule nobody wrote
 * would be worse than not sectioning at all.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECTIONED_INTERVIEW_SETTINGS,
  MAX_TURNS_PER_SECTION,
  narrowSectionedInterviewSettings,
} from '@/lib/app/questionnaire/sections/settings';

describe('narrowSectionedInterviewSettings', () => {
  it('resolves an empty blob to the documented defaults', () => {
    expect(narrowSectionedInterviewSettings({})).toEqual(DEFAULT_SECTIONED_INTERVIEW_SETTINGS);
  });

  it.each([null, undefined, 'nonsense', 42, [], true])(
    'degrades %p to the defaults, which means the feature is off',
    (value) => {
      const settings = narrowSectionedInterviewSettings(value);
      expect(settings).toEqual(DEFAULT_SECTIONED_INTERVIEW_SETTINGS);
      expect(settings.enabled).toBe(false);
    }
  );

  it('keeps the fields it can read and defaults the ones it cannot', () => {
    expect(
      narrowSectionedInterviewSettings({
        enabled: true,
        navigation: 'free',
        // Unreadable: falls back rather than dragging the whole blob down.
        tangentPolicy: 'whatever',
        unknownKey: 'dropped',
      })
    ).toEqual({
      ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS,
      enabled: true,
      navigation: 'free',
    });
  });

  it('falls back to auto for an unreadable source rather than pinning a grouping', () => {
    // Pinning is a decision the author makes. Inventing one from a corrupt value would silently
    // section an interview by a grouping nobody chose.
    expect(narrowSectionedInterviewSettings({ source: 'topics' }).source).toBe('topics');
    expect(narrowSectionedInterviewSettings({ source: 'auto' }).source).toBe('auto');
    expect(narrowSectionedInterviewSettings({ source: 'themes ' }).source).toBe('auto');
    expect(narrowSectionedInterviewSettings({ source: 99 }).source).toBe('auto');
  });

  it('clamps numbers into range instead of rejecting the blob', () => {
    const settings = narrowSectionedInterviewSettings({
      closeCoverage: 4.2,
      closeMinAnswered: -8,
      maxTurnsPerSection: 10_000,
    });
    expect(settings.closeCoverage).toBe(1);
    expect(settings.closeMinAnswered).toBe(0);
    expect(settings.maxTurnsPerSection).toBe(MAX_TURNS_PER_SECTION);
  });

  it('rounds the two integer bars, since a fractional turn cap is not a thing', () => {
    const settings = narrowSectionedInterviewSettings({
      closeMinAnswered: 3.7,
      maxTurnsPerSection: 6.2,
    });
    expect(settings.closeMinAnswered).toBe(4);
    expect(settings.maxTurnsPerSection).toBe(6);
  });

  it('defaults to capture-but-never-chase, not to dropping volunteered answers', () => {
    // The default has to keep signal a respondent freely gave. `stay` is the opt-in.
    expect(DEFAULT_SECTIONED_INTERVIEW_SETTINGS.tangentPolicy).toBe('capture');
  });
});
