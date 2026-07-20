/**
 * Experience settings → defensive projection.
 *
 * {@link narrowExperienceSettings} coerces the opaque `settings` Json column (which we wrote, but
 * may be `{}`, partial, legacy, or hand-edited) into a complete, bounded
 * {@link ExperienceSettingsShape} — booleans strict, free text trimmed + length-capped, numbers
 * clamped into range. The read path and tests share it. Pure, no I/O — the sibling of
 * `narrowIntroSettings` (`lib/app/questionnaire/intro/settings.ts`) and
 * `narrowRespondentReportSettings` (`lib/app/questionnaire/report/settings.ts`).
 */

import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  BREAKOUT_GRACE_MAX_SECONDS,
  BREAKOUT_GRACE_MIN_SECONDS,
  DEFAULT_EXPERIENCE_SETTINGS,
  EXPERIENCE_CONSOLE_DISPLAYS,
  EXPERIENCE_INSIGHT_DISPLAYS,
  EXPERIENCE_SEAM_MARKERS,
  EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH,
  INSIGHT_MIN_SUPPORT_CEILING,
  INSIGHT_MIN_SUPPORT_FLOOR,
  SYNTHESIS_EVERY_N_MAX,
  SYNTHESIS_EVERY_N_MIN,
  type ExperienceSettingsShape,
} from '@/lib/app/questionnaire/experiences/types';
import { isRecord } from '@/lib/utils';

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

/**
 * Clamp a stored number into range.
 *
 * Non-finite values (NaN and Infinity are both reachable through JSON round-trips and hand-edited
 * rows) fall back rather than clamping to a bound — neither bound is a defensible reading of "not
 * a number", and silently treating NaN as the floor would quietly change behaviour.
 */
function asInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Project the stored `settings` Json onto a complete {@link ExperienceSettingsShape}. Missing keys
 * fall back to {@link DEFAULT_EXPERIENCE_SETTINGS}; unknown keys are dropped.
 */
export function narrowExperienceSettings(value: unknown): ExperienceSettingsShape {
  const obj = isRecord(value) ? value : {};
  const d = DEFAULT_EXPERIENCE_SETTINGS;
  return {
    summariseCarryOver: asBool(obj.summariseCarryOver, d.summariseCarryOver),
    carryProfile: asBool(obj.carryProfile, d.carryProfile),
    showRoutingRationale: asBool(obj.showRoutingRationale, d.showRoutingRationale),
    stitchedSeamMarker: narrowToEnum(
      typeof obj.stitchedSeamMarker === 'string' ? obj.stitchedSeamMarker : '',
      EXPERIENCE_SEAM_MARKERS,
      d.stitchedSeamMarker
    ),
    synthesisEveryNCompletions: asInt(
      obj.synthesisEveryNCompletions,
      SYNTHESIS_EVERY_N_MIN,
      SYNTHESIS_EVERY_N_MAX,
      d.synthesisEveryNCompletions
    ),
    insightMinSupport: asInt(
      obj.insightMinSupport,
      INSIGHT_MIN_SUPPORT_FLOOR,
      INSIGHT_MIN_SUPPORT_CEILING,
      d.insightMinSupport
    ),
    surfaceInsightsToRespondents: asBool(
      obj.surfaceInsightsToRespondents,
      d.surfaceInsightsToRespondents
    ),
    respondentInsightDisplay: narrowToEnum(
      typeof obj.respondentInsightDisplay === 'string' ? obj.respondentInsightDisplay : '',
      EXPERIENCE_INSIGHT_DISPLAYS,
      d.respondentInsightDisplay
    ),
    consoleDisplayMode: narrowToEnum(
      typeof obj.consoleDisplayMode === 'string' ? obj.consoleDisplayMode : '',
      EXPERIENCE_CONSOLE_DISPLAYS,
      d.consoleDisplayMode
    ),
    breakoutGraceSeconds: asInt(
      obj.breakoutGraceSeconds,
      BREAKOUT_GRACE_MIN_SECONDS,
      BREAKOUT_GRACE_MAX_SECONDS,
      d.breakoutGraceSeconds
    ),
    synthesisInstructions: asText(
      obj.synthesisInstructions,
      EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH,
      d.synthesisInstructions
    ),
  };
}
