/**
 * Respondent Report settings → defensive projection (report kind `respondent`).
 *
 * {@link narrowRespondentReportSettings} coerces the opaque `respondentReport` Json column (which we
 * wrote, but may be `{}`, partial, legacy-null, or malformed) into a complete, bounded
 * {@link RespondentReportSettings} — every sub-object present, booleans strict, free text trimmed +
 * length-capped, mode narrowed to the enum. The read path and tests share it. Pure, no I/O — the
 * sibling of `narrowToneSettings` in `lib/app/questionnaire/chat/tone.ts`.
 */

import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_MODES,
  RESPONDENT_REPORT_NARRATIVE_STYLES,
  type RespondentReportMode,
  type RespondentReportNarrativeStyle,
  type RespondentReportSettings,
} from '@/lib/app/questionnaire/types';
import { isRecord } from '@/lib/utils';

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function asMode(value: unknown): RespondentReportMode {
  return typeof value === 'string' && (RESPONDENT_REPORT_MODES as readonly string[]).includes(value)
    ? (value as RespondentReportMode)
    : DEFAULT_RESPONDENT_REPORT_SETTINGS.mode;
}

function asNarrativeStyle(value: unknown): RespondentReportNarrativeStyle {
  return typeof value === 'string' &&
    (RESPONDENT_REPORT_NARRATIVE_STYLES as readonly string[]).includes(value)
    ? (value as RespondentReportNarrativeStyle)
    : DEFAULT_RESPONDENT_REPORT_SETTINGS.generation.narrativeStyle;
}

/**
 * Project the stored `respondentReport` Json onto a complete {@link RespondentReportSettings}.
 * Missing keys fall back to {@link DEFAULT_RESPONDENT_REPORT_SETTINGS}; unknown keys are dropped.
 */
export function narrowRespondentReportSettings(value: unknown): RespondentReportSettings {
  const obj = isRecord(value) ? value : {};
  const rawIncludes = isRecord(obj.rawIncludes) ? obj.rawIncludes : {};
  const generation = isRecord(obj.generation) ? obj.generation : {};
  const delivery = isRecord(obj.delivery) ? obj.delivery : {};
  const d = DEFAULT_RESPONDENT_REPORT_SETTINGS;

  return {
    enabled: asBool(obj.enabled, d.enabled),
    mode: asMode(obj.mode),
    rawIncludes: {
      dataSlots: asBool(rawIncludes.dataSlots, d.rawIncludes.dataSlots),
      questionsAsPresented: asBool(
        rawIncludes.questionsAsPresented,
        d.rawIncludes.questionsAsPresented
      ),
    },
    generation: {
      narrativeStyle: asNarrativeStyle(generation.narrativeStyle),
      instructions: asText(
        generation.instructions,
        RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
        d.generation.instructions
      ),
      structure: asText(
        generation.structure,
        RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
        d.generation.structure
      ),
      backgroundContext: asText(
        generation.backgroundContext,
        RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
        d.generation.backgroundContext
      ),
      useClientKnowledge: asBool(generation.useClientKnowledge, d.generation.useClientKnowledge),
    },
    delivery: {
      onScreen: asBool(delivery.onScreen, d.delivery.onScreen),
      download: asBool(delivery.download, d.delivery.download),
    },
  };
}
