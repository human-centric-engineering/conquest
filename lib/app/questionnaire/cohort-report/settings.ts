/**
 * Cohort Report settings → defensive projection (report kind `cohort`).
 *
 * {@link narrowCohortReportSettings} coerces the opaque `cohortReport` Json column (which we wrote,
 * but may be `{}`, partial, legacy-null, or malformed) into a complete, bounded
 * {@link CohortReportSettings} — every sub-object present, booleans strict, enums narrowed, free
 * text trimmed + length-capped. The read path and tests share it. Pure, no I/O — the sibling of
 * `narrowRespondentReportSettings` in `lib/app/questionnaire/report/settings.ts`.
 */

import {
  COHORT_REPORT_BACKGROUND_MAX_LENGTH,
  COHORT_REPORT_DETAIL_LEVELS,
  COHORT_REPORT_FORMALITIES,
  COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  COHORT_REPORT_LENGTHS,
  DEFAULT_COHORT_REPORT_SETTINGS,
  type CohortReportDetailLevel,
  type CohortReportFormality,
  type CohortReportLength,
  type CohortReportSettings,
} from '@/lib/app/questionnaire/types';
import { isRecord } from '@/lib/utils';

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function asLength(value: unknown): CohortReportLength {
  return typeof value === 'string' && (COHORT_REPORT_LENGTHS as readonly string[]).includes(value)
    ? (value as CohortReportLength)
    : DEFAULT_COHORT_REPORT_SETTINGS.generation.length;
}

function asDetailLevel(value: unknown): CohortReportDetailLevel {
  return typeof value === 'string' &&
    (COHORT_REPORT_DETAIL_LEVELS as readonly string[]).includes(value)
    ? (value as CohortReportDetailLevel)
    : DEFAULT_COHORT_REPORT_SETTINGS.generation.detailLevel;
}

function asFormality(value: unknown): CohortReportFormality {
  return typeof value === 'string' &&
    (COHORT_REPORT_FORMALITIES as readonly string[]).includes(value)
    ? (value as CohortReportFormality)
    : DEFAULT_COHORT_REPORT_SETTINGS.generation.formality;
}

/**
 * Project the stored `cohortReport` Json onto a complete {@link CohortReportSettings}.
 * Missing keys fall back to {@link DEFAULT_COHORT_REPORT_SETTINGS}; unknown keys are dropped.
 */
export function narrowCohortReportSettings(value: unknown): CohortReportSettings {
  const obj = isRecord(value) ? value : {};
  const generation = isRecord(obj.generation) ? obj.generation : {};
  const d = DEFAULT_COHORT_REPORT_SETTINGS;

  return {
    enabled: asBool(obj.enabled, d.enabled),
    generation: {
      length: asLength(generation.length),
      detailLevel: asDetailLevel(generation.detailLevel),
      formality: asFormality(generation.formality),
      instructions: asText(
        generation.instructions,
        COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
        d.generation.instructions
      ),
      structure: asText(
        generation.structure,
        COHORT_REPORT_INSTRUCTIONS_MAX_LENGTH,
        d.generation.structure
      ),
      backgroundContext: asText(
        generation.backgroundContext,
        COHORT_REPORT_BACKGROUND_MAX_LENGTH,
        d.generation.backgroundContext
      ),
      useClientKnowledge: asBool(generation.useClientKnowledge, d.generation.useClientKnowledge),
      useRoundContext: asBool(generation.useRoundContext, d.generation.useRoundContext),
      useCohortContext: asBool(generation.useCohortContext, d.generation.useCohortContext),
      scoringEnabled: asBool(generation.scoringEnabled, d.generation.scoringEnabled),
    },
  };
}
