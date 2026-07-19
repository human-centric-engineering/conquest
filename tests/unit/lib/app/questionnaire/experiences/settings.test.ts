import { describe, it, expect } from 'vitest';

import { narrowExperienceSettings } from '@/lib/app/questionnaire/experiences/settings';
import {
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

  it('defaults the k-anonymity floor to at least three supporters', () => {
    // Two people can usually identify each other from "a tension between two of you"; three is the
    // smallest group where that stops being true. Guard the default so it is not lowered casually.
    expect(DEFAULT_EXPERIENCE_SETTINGS.insightMinSupport).toBeGreaterThanOrEqual(3);
    expect(INSIGHT_MIN_SUPPORT_FLOOR).toBeGreaterThanOrEqual(2);
  });
});
