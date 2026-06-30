/**
 * Respondent intro / splash settings → defensive projection.
 *
 * {@link narrowIntroSettings} coerces the opaque `intro` Json column (which we wrote, but may be
 * `{}`, partial, legacy-null, or malformed) into a complete, bounded {@link IntroSettings} — booleans
 * strict, free text trimmed + length-capped. The read path and tests share it. Pure, no I/O — the
 * sibling of `narrowRespondentReportSettings` (`lib/app/questionnaire/report/settings.ts`).
 */

import {
  DEFAULT_INTRO_SETTINGS,
  INTRO_BACKGROUND_MAX_LENGTH,
  INTRO_BUTTON_LABEL_MAX_LENGTH,
  INTRO_VIDEO_URL_MAX_LENGTH,
  type IntroSettings,
} from '@/lib/app/questionnaire/types';
import { isRecord } from '@/lib/utils';

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

/**
 * Project the stored `intro` Json onto a complete {@link IntroSettings}. Missing keys fall back to
 * {@link DEFAULT_INTRO_SETTINGS}; unknown keys are dropped.
 */
export function narrowIntroSettings(value: unknown): IntroSettings {
  const obj = isRecord(value) ? value : {};
  const d = DEFAULT_INTRO_SETTINGS;
  return {
    enabled: asBool(obj.enabled, d.enabled),
    background: asText(obj.background, INTRO_BACKGROUND_MAX_LENGTH, d.background),
    buttonLabel: asText(obj.buttonLabel, INTRO_BUTTON_LABEL_MAX_LENGTH, d.buttonLabel),
    videoUrl: asText(obj.videoUrl, INTRO_VIDEO_URL_MAX_LENGTH, d.videoUrl),
  };
}
