import { describe, it, expect } from 'vitest';

import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
  BREAKOUT_GRACE_MAX_SECONDS,
  BREAKOUT_GRACE_MIN_SECONDS,
  DEFAULT_EXPERIENCE_SETTINGS,
  EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH,
  INSIGHT_MIN_SUPPORT_CEILING,
  INSIGHT_MIN_SUPPORT_FLOOR,
  SYNTHESIS_EVERY_N_MAX,
  SYNTHESIS_EVERY_N_MIN,
} from '@/lib/app/questionnaire/experiences/types';

/**
 * `narrowExperienceSettings` is the only read path for the lazily-defaulted `settings` Json
 * column, so every malformed shape the column can actually hold is exercised here: an absent row
 * (`{}`), a partial write, a legacy key we no longer recognise, and hand-edited junk.
 */
describe('narrowExperienceSettings', () => {
  it('returns the defaults for an absent or empty settings column', () => {
    // A lazily-created row has never been written, so `{}` (and null, from an older shape) must
    // resolve to the full default set rather than an object of undefineds.
    expect(narrowExperienceSettings({})).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
    expect(narrowExperienceSettings(null)).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
    expect(narrowExperienceSettings(undefined)).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
  });

  it('returns the defaults for a non-object column value', () => {
    expect(narrowExperienceSettings('nonsense')).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
    expect(narrowExperienceSettings(42)).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
    expect(narrowExperienceSettings([])).toEqual(DEFAULT_EXPERIENCE_SETTINGS);
  });

  it('fills missing keys from the defaults while keeping the supplied ones', () => {
    const result = narrowExperienceSettings({ summariseCarryOver: false });

    expect(result.summariseCarryOver).toBe(false);
    expect(result.carryProfile).toBe(DEFAULT_EXPERIENCE_SETTINGS.carryProfile);
    expect(result.insightMinSupport).toBe(DEFAULT_EXPERIENCE_SETTINGS.insightMinSupport);
  });

  it('drops unknown keys rather than passing them through', () => {
    const result = narrowExperienceSettings({
      summariseCarryOver: false,
      legacyKeyFromAnOlderShape: 'should not survive',
    });

    expect(result).not.toHaveProperty('legacyKeyFromAnOlderShape');
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_EXPERIENCE_SETTINGS).sort());
  });

  it('falls back rather than coercing when a boolean holds a non-boolean', () => {
    // Truthy strings must NOT read as `true` — a settings column that silently coerces would let
    // a bad write flip behaviour invisibly.
    const result = narrowExperienceSettings({
      summariseCarryOver: 'yes',
      carryProfile: 1,
      surfaceInsightsToRespondents: null,
    });

    expect(result.summariseCarryOver).toBe(DEFAULT_EXPERIENCE_SETTINGS.summariseCarryOver);
    expect(result.carryProfile).toBe(DEFAULT_EXPERIENCE_SETTINGS.carryProfile);
    expect(result.surfaceInsightsToRespondents).toBe(
      DEFAULT_EXPERIENCE_SETTINGS.surfaceInsightsToRespondents
    );
  });

  it('clamps out-of-range numbers into their bounds', () => {
    const low = narrowExperienceSettings({
      synthesisEveryNCompletions: -5,
      insightMinSupport: 0,
    });
    expect(low.synthesisEveryNCompletions).toBe(SYNTHESIS_EVERY_N_MIN);
    expect(low.insightMinSupport).toBe(INSIGHT_MIN_SUPPORT_FLOOR);

    const high = narrowExperienceSettings({
      synthesisEveryNCompletions: 10_000,
      insightMinSupport: 10_000,
    });
    expect(high.synthesisEveryNCompletions).toBe(SYNTHESIS_EVERY_N_MAX);
    expect(high.insightMinSupport).toBe(INSIGHT_MIN_SUPPORT_CEILING);
  });

  it('rounds fractional numbers to integers', () => {
    expect(
      narrowExperienceSettings({ synthesisEveryNCompletions: 3.7 }).synthesisEveryNCompletions
    ).toBe(4);
  });

  it('falls back rather than clamping when a number is not finite', () => {
    // NaN and Infinity both survive a JSON round-trip via hand-edited rows. Clamping NaN to the
    // floor would silently change behaviour; neither bound is a defensible reading of "not a
    // number", so the default is the only honest answer.
    const result = narrowExperienceSettings({
      synthesisEveryNCompletions: Number.NaN,
      insightMinSupport: Number.POSITIVE_INFINITY,
    });

    expect(result.synthesisEveryNCompletions).toBe(
      DEFAULT_EXPERIENCE_SETTINGS.synthesisEveryNCompletions
    );
    // Infinity IS finite-checked, so it falls back rather than clamping to the ceiling.
    expect(result.insightMinSupport).toBe(DEFAULT_EXPERIENCE_SETTINGS.insightMinSupport);
  });

  it('trims and length-caps free text', () => {
    expect(
      narrowExperienceSettings({ synthesisInstructions: '  padded  ' }).synthesisInstructions
    ).toBe('padded');

    const overlong = 'x'.repeat(EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH + 500);
    expect(
      narrowExperienceSettings({ synthesisInstructions: overlong }).synthesisInstructions
    ).toHaveLength(EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH);
  });

  it('is idempotent — narrowing an already-narrowed value changes nothing', () => {
    const once = narrowExperienceSettings({ summariseCarryOver: false, insightMinSupport: 7 });
    expect(narrowExperienceSettings(once)).toEqual(once);
  });

  describe('stitchedSeamMarker (P15.3)', () => {
    it('accepts both markers', () => {
      expect(narrowExperienceSettings({ stitchedSeamMarker: 'none' }).stitchedSeamMarker).toBe(
        'none'
      );
      expect(narrowExperienceSettings({ stitchedSeamMarker: 'divider' }).stitchedSeamMarker).toBe(
        'divider'
      );
    });

    it.each([
      ['an unknown string', 'subtle'],
      ['a boolean', true],
      ['null', null],
      ['a number', 1],
    ])('falls back to the default for %s', (_label, value) => {
      expect(narrowExperienceSettings({ stitchedSeamMarker: value }).stitchedSeamMarker).toBe(
        DEFAULT_EXPERIENCE_SETTINGS.stitchedSeamMarker
      );
    });

    it('defaults to showing the divider', () => {
      // A respondent moving from a broad opener into a materially more probing follow-up should be
      // able to SEE the subject changed. Hiding the seam must stay an explicit author choice — the
      // opposite default would conceal it by accident.
      expect(DEFAULT_EXPERIENCE_SETTINGS.stitchedSeamMarker).toBe('divider');
    });
  });

  describe('facilitated-meeting display + grace (P15.5)', () => {
    it('defaults respondent insight display to the shared screen only', () => {
      // A facilitated meeting is a room looking at one thing together; putting the analysis on
      // forty phones by default changes that without anyone asking for it.
      expect(DEFAULT_EXPERIENCE_SETTINGS.respondentInsightDisplay).toBe('none');
    });

    it.each(['none', 'tab', 'modal'] as const)('accepts the %s display', (mode) => {
      expect(
        narrowExperienceSettings({ respondentInsightDisplay: mode }).respondentInsightDisplay
      ).toBe(mode);
    });

    it('falls back for an unknown display value', () => {
      expect(
        narrowExperienceSettings({ respondentInsightDisplay: 'sidebar' }).respondentInsightDisplay
      ).toBe(DEFAULT_EXPERIENCE_SETTINGS.respondentInsightDisplay);
    });

    it.each(['standard', 'presentation'] as const)('accepts the %s console mode', (mode) => {
      expect(narrowExperienceSettings({ consoleDisplayMode: mode }).consoleDisplayMode).toBe(mode);
    });

    it('defaults the grace window to 30 seconds', () => {
      // Long enough to finish a sentence and press send; short enough that the room does not drift.
      expect(DEFAULT_EXPERIENCE_SETTINGS.breakoutGraceSeconds).toBe(30);
    });

    it('clamps the grace window into range', () => {
      expect(narrowExperienceSettings({ breakoutGraceSeconds: 99_999 }).breakoutGraceSeconds).toBe(
        BREAKOUT_GRACE_MAX_SECONDS
      );
      expect(narrowExperienceSettings({ breakoutGraceSeconds: -10 }).breakoutGraceSeconds).toBe(
        BREAKOUT_GRACE_MIN_SECONDS
      );
    });

    it('allows zero grace — an author may want a hard stop', () => {
      expect(narrowExperienceSettings({ breakoutGraceSeconds: 0 }).breakoutGraceSeconds).toBe(0);
    });

    it('falls back for a non-numeric grace rather than clamping it', () => {
      expect(narrowExperienceSettings({ breakoutGraceSeconds: 'soon' }).breakoutGraceSeconds).toBe(
        DEFAULT_EXPERIENCE_SETTINGS.breakoutGraceSeconds
      );
    });
  });

  it('defaults the k-anonymity floor to at least three supporters', () => {
    // Two people can usually identify each other from "a tension between two of you"; three is the
    // smallest group where that stops being true. Guard the default so it is not lowered casually.
    expect(DEFAULT_EXPERIENCE_SETTINGS.insightMinSupport).toBeGreaterThanOrEqual(3);
    expect(INSIGHT_MIN_SUPPORT_FLOOR).toBeGreaterThanOrEqual(2);
  });
});
