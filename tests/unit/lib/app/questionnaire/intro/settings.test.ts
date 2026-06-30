/**
 * narrowIntroSettings — defensive projection of the stored `intro` Json column.
 *
 * Asserts it always returns a complete {@link IntroSettings}: missing/garbage keys fall back to
 * defaults, booleans are strict, free text is trimmed + length-capped, and unknown keys are dropped.
 *
 * @see lib/app/questionnaire/intro/settings.ts
 */

import { describe, it, expect } from 'vitest';

import { narrowIntroSettings } from '@/lib/app/questionnaire/intro/settings';
import {
  DEFAULT_INTRO_SETTINGS,
  INTRO_BACKGROUND_MAX_LENGTH,
  INTRO_BUTTON_LABEL_MAX_LENGTH,
  INTRO_VIDEO_URL_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';

describe('narrowIntroSettings', () => {
  it.each([null, undefined, 42, 'string', [], {}])(
    'returns the complete default for non-object / empty input (%p)',
    (value) => {
      expect(narrowIntroSettings(value)).toEqual(DEFAULT_INTRO_SETTINGS);
    }
  );

  it('passes a well-formed object through verbatim', () => {
    const stored = {
      enabled: true,
      background: 'About us',
      buttonLabel: 'Begin',
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    };
    expect(narrowIntroSettings(stored)).toEqual(stored);
  });

  it('trims/caps videoUrl and defaults a non-string', () => {
    expect(narrowIntroSettings({ videoUrl: '  https://youtu.be/x  ' }).videoUrl).toBe(
      'https://youtu.be/x'
    );
    expect(
      narrowIntroSettings({ videoUrl: 'h'.repeat(INTRO_VIDEO_URL_MAX_LENGTH + 50) }).videoUrl
    ).toHaveLength(INTRO_VIDEO_URL_MAX_LENGTH);
    expect(narrowIntroSettings({ videoUrl: 123 }).videoUrl).toBe(DEFAULT_INTRO_SETTINGS.videoUrl);
  });

  it('coerces a non-boolean enabled to the default', () => {
    expect(narrowIntroSettings({ enabled: 'yes' }).enabled).toBe(DEFAULT_INTRO_SETTINGS.enabled);
  });

  it('trims background and button label', () => {
    const out = narrowIntroSettings({ background: '  hi  ', buttonLabel: '  go  ' });
    expect(out.background).toBe('hi');
    expect(out.buttonLabel).toBe('go');
  });

  it('caps background and button label at their max lengths', () => {
    const out = narrowIntroSettings({
      background: 'a'.repeat(INTRO_BACKGROUND_MAX_LENGTH + 50),
      buttonLabel: 'b'.repeat(INTRO_BUTTON_LABEL_MAX_LENGTH + 50),
    });
    expect(out.background).toHaveLength(INTRO_BACKGROUND_MAX_LENGTH);
    expect(out.buttonLabel).toHaveLength(INTRO_BUTTON_LABEL_MAX_LENGTH);
  });

  it('falls back to defaults for non-string text fields', () => {
    const out = narrowIntroSettings({ background: 123, buttonLabel: {} });
    expect(out.background).toBe(DEFAULT_INTRO_SETTINGS.background);
    expect(out.buttonLabel).toBe(DEFAULT_INTRO_SETTINGS.buttonLabel);
  });

  it('drops unknown keys', () => {
    expect(narrowIntroSettings({ enabled: true, rogue: 'x' })).not.toHaveProperty('rogue');
  });
});
