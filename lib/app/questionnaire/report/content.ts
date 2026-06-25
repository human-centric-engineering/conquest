/**
 * Respondent Report generated content — the shape stored in `AppRespondentReport.content` and
 * rendered on the completion screen + in the PDF (the AI modes `raw_plus_insights` and `narrative`
 * share this shape; `narrative` fills `sections` with woven chapters rather than discrete insights).
 *
 * Two pure pieces, no I/O:
 *   - {@link validateRespondentReportContent} narrows the agent's parsed JSON onto the strict
 *     {@link RespondentReportContent} (trims, length/count caps, drops malformed entries) — the
 *     generation parser and the read path share it.
 *   - {@link buildAnswerTranscript} flattens a {@link SessionExportModel} into the plain-text Q&A
 *     transcript fed to the report agent.
 */

import { isRecord } from '@/lib/utils';
import { readChoicesConfig } from '@/lib/app/questionnaire/form/type-config';
import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/**
 * The structural subset of {@link SessionExportModel} the transcript needs. A full
 * `SessionExportModel` satisfies it (Phase 5 passes one directly); generation builds a lighter
 * object so it never has to construct theme/identity it doesn't use.
 */
export type AnswerTranscriptInput = Pick<
  SessionExportModel,
  'questionnaireTitle' | 'goal' | 'audienceSummary' | 'sections'
>;

/** One titled section of the insights report. */
export interface RespondentReportSection {
  heading: string;
  body: string;
}

/** The generated insights payload (the `content` column for a mode-2 report). */
export interface RespondentReportContent {
  /** A short overview paragraph. */
  summary: string;
  /** Titled analysis sections. */
  sections: RespondentReportSection[];
  /** Concrete, actionable next steps the respondent can take. */
  actions: string[];
}

/** Bounds — keep a report readable and a runaway model in check. */
export const REPORT_SUMMARY_MAX = 4000;
export const REPORT_SECTION_HEADING_MAX = 200;
export const REPORT_SECTION_BODY_MAX = 6000;
export const REPORT_ACTION_MAX = 1000;
export const REPORT_MAX_SECTIONS = 12;
export const REPORT_MAX_ACTIONS = 12;

function trimTo(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * Narrow arbitrary parsed JSON onto a valid {@link RespondentReportContent}, or `null` when it
 * can't be salvaged (no usable summary). Malformed individual sections/actions are dropped rather
 * than failing the whole report.
 */
export function validateRespondentReportContent(parsed: unknown): RespondentReportContent | null {
  if (!isRecord(parsed)) return null;

  const summary = trimTo(parsed.summary, REPORT_SUMMARY_MAX);
  if (!summary) return null; // a report with no summary is not useful

  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections: RespondentReportSection[] = [];
  for (const entry of rawSections) {
    if (sections.length >= REPORT_MAX_SECTIONS) break;
    if (!isRecord(entry)) continue;
    const heading = trimTo(entry.heading, REPORT_SECTION_HEADING_MAX);
    const body = trimTo(entry.body, REPORT_SECTION_BODY_MAX);
    if (heading && body) sections.push({ heading, body });
  }

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: string[] = [];
  for (const entry of rawActions) {
    if (actions.length >= REPORT_MAX_ACTIONS) break;
    const action = trimTo(entry, REPORT_ACTION_MAX);
    if (action) actions.push(action);
  }

  return { summary, sections, actions };
}

/** Render one scalar/object as a compact string (objects → JSON; never `[object Object]`). */
function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Render a single captured answer value as a compact string for the transcript. */
function formatAnswerValue(value: unknown): string {
  if (value === null || value === undefined) return '(no answer)';
  if (Array.isArray(value)) return value.map(stringifyScalar).join(', ');
  return stringifyScalar(value);
}

/**
 * The respondent-facing text of a captured answer: a single/multi-choice answer is stored as its
 * option `value` (a slug), so map it to the option `label` the respondent actually saw before
 * formatting. Everything else (and any value whose key isn't in the option list) falls through to
 * {@link formatAnswerValue} unchanged, preserving the transcript's scalar rendering.
 */
function formatSlotAnswerForTranscript(slot: PanelSlotView): string {
  if (slot.type === 'single_choice' || slot.type === 'multi_choice') {
    const config = readChoicesConfig(slot.type, slot.typeConfig);
    if (config) {
      const labelByValue = new Map(config.choices.map((c) => [c.value, c.label]));
      const toLabel = (v: unknown): unknown =>
        typeof v === 'string' && labelByValue.has(v) ? labelByValue.get(v) : v;
      const mapped = Array.isArray(slot.value) ? slot.value.map(toLabel) : toLabel(slot.value);
      return formatAnswerValue(mapped);
    }
  }
  return formatAnswerValue(slot.value);
}

/**
 * Flatten the export model into a plain-text Q&A transcript for the report agent. Only answered
 * slots are included (an unanswered slot adds noise, not signal); sections with no answers are
 * skipped. Leads with the questionnaire goal/audience for grounding.
 */
export function buildAnswerTranscript(model: AnswerTranscriptInput): string {
  const lines: string[] = [];
  lines.push(`Questionnaire: ${model.questionnaireTitle}`);
  if (model.goal) lines.push(`Goal: ${model.goal}`);
  if (model.audienceSummary) lines.push(`Audience: ${model.audienceSummary}`);
  lines.push('');

  for (const section of model.sections) {
    const answered = section.slots.filter((s) => s.answered);
    if (answered.length === 0) continue;
    lines.push(`## ${section.title}`);
    for (const slot of answered) {
      lines.push(`Q: ${slot.prompt}`);
      // Choice answers render their respondent-facing labels, not their stored option keys.
      lines.push(`A: ${formatSlotAnswerForTranscript(slot)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
