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
  MAX_REPORT_RESEARCH_RESULTS,
  MAX_REPORT_RESEARCH_ROUNDS,
  REPORT_RESEARCH_DISPLAYS,
  REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
  REPORT_RESEARCH_TIMINGS,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_MODES,
  RESPONDENT_REPORT_NARRATIVE_STYLES,
  type ReportResearchDisplay,
  type ReportResearchTiming,
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

/** Clamp an arbitrary value to an integer within [min, max], falling back when non-numeric. */
function asBoundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asResearchTiming(value: unknown): ReportResearchTiming {
  return typeof value === 'string' && (REPORT_RESEARCH_TIMINGS as readonly string[]).includes(value)
    ? (value as ReportResearchTiming)
    : DEFAULT_RESPONDENT_REPORT_SETTINGS.research.timing;
}

function asResearchDisplay(value: unknown): ReportResearchDisplay {
  return typeof value === 'string' &&
    (REPORT_RESEARCH_DISPLAYS as readonly string[]).includes(value)
    ? (value as ReportResearchDisplay)
    : DEFAULT_RESPONDENT_REPORT_SETTINGS.research.display;
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
  const research = isRecord(obj.research) ? obj.research : {};
  const researchBefore = isRecord(research.before) ? research.before : {};
  const researchAfter = isRecord(research.after) ? research.after : {};
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
    research: {
      enabled: asBool(research.enabled, d.research.enabled),
      timing: asResearchTiming(research.timing),
      rounds: asBoundedInt(research.rounds, 1, MAX_REPORT_RESEARCH_ROUNDS, d.research.rounds),
      maxResults: asBoundedInt(
        research.maxResults,
        1,
        MAX_REPORT_RESEARCH_RESULTS,
        d.research.maxResults
      ),
      before: {
        instructions: asText(
          researchBefore.instructions,
          REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
          d.research.before.instructions
        ),
      },
      after: {
        instructions: asText(
          researchAfter.instructions,
          REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
          d.research.after.instructions
        ),
      },
      display: asResearchDisplay(research.display),
      informNarrative: asBool(research.informNarrative, d.research.informNarrative),
      appendix: asBool(research.appendix, d.research.appendix),
    },
  };
}

/**
 * Effective questionnaire-data includes for the RESPONDENT-facing report surfaces (the completion
 * screen and the respondent PDF), derived from `rawIncludes` + the report `mode`.
 *
 * A `narrative` report is a standalone woven deliverable, so it NEVER appends the raw questions-&-answers
 * recap beneath the prose — this restores the pre-F10.6 `narrativeOnly` invariant. It is enforced here
 * (rather than trusting the stored flag) on purpose: versions configured as `narrative` before F10.6
 * carry `rawIncludes.questionsAsPresented: true` (the field's default, which the old narrative flow
 * ignored), so honouring it verbatim would silently start surfacing a full Q&A recap on those existing
 * reports. Suppressing it at read time keeps them woven-only with no data backfill.
 *
 * The captured data-slot appendix stays config-driven in every mode: it is new in F10.6 and defaults
 * OFF, so no pre-existing version can regress into showing it, and a narrative report may still opt in.
 *
 * Single source of truth for both the render (`view.ts`) and the writer prompt's `includesAppendedData`
 * hint (`generate.ts`), so the two can never drift.
 */
export function resolveReportRawIncludes(settings: RespondentReportSettings): {
  questions: boolean;
  dataSlots: boolean;
} {
  return {
    questions: settings.mode === 'narrative' ? false : settings.rawIncludes.questionsAsPresented,
    dataSlots: settings.rawIncludes.dataSlots,
  };
}
