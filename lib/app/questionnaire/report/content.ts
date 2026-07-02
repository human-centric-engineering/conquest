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
import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';
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

/**
 * Paragraph size bounds for the deterministic sub-split. A display paragraph is closed when it
 * reaches {@link MAX_SENTENCES_PER_PARAGRAPH} sentences OR adding the next sentence would push it past
 * {@link SOFT_CHAR_LIMIT} characters — whichever comes first (always ≥1 sentence per paragraph). The
 * char budget is what makes long-sentence prose break into even ~3-line paragraphs rather than
 * 5-line ones when three sentences happen to be very long.
 */
const MAX_SENTENCES_PER_PARAGRAPH = 3;
const SOFT_CHAR_LIMIT = 280;

/**
 * Split a plain-prose block into sentences. Boundary = sentence-ending punctuation followed by
 * whitespace and the start of a new sentence (a capital letter, digit, or opening quote). Decimals
 * (`4.5`) and mid-sentence dots don't match (no capitalised follow-on); the odd abbreviation
 * (`e.g.`) may over-split, which is a far smaller readability cost than a 15-line wall of text.
 */
function splitSentences(block: string): string[] {
  return block
    .split(/(?<=[.!?])\s+(?=["“'']?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split a report summary/body into display paragraphs so the renderers (PDF + on-screen) lay it out
 * with real inter-paragraph spacing rather than one wall of text. Two passes:
 *
 *  1. Split on blank lines (one or more newlines with only whitespace between) — the agent is asked to
 *     separate paragraphs this way. Single newlines are preserved *within* a block, so a run of bullet
 *     lines the model wrote as consecutive `- …` lines stays one block with its line breaks intact.
 *  2. Deterministically sub-split any remaining plain-prose block into paragraphs bounded by
 *     {@link MAX_SENTENCES_PER_PARAGRAPH} sentences and {@link SOFT_CHAR_LIMIT} characters (greedy
 *     grouping). This is the load-bearing fix: models frequently return one giant paragraph with no
 *     blank lines, so pass 1 alone leaves a wall of text — pass 2 breaks it up regardless of what the
 *     model did (and fixes already-stored reports, since it runs at render time). Blocks that contain
 *     line breaks (bullet lists) are left whole, never sentence-split.
 *
 * A short body returns a single-element array (its whole text). Pure — shared by both renderers.
 */
export function splitReportParagraphs(text: string): string[] {
  const blocks = text
    // Normalise CRLF/CR (Windows-authored answers the model may echo) to LF first, so a `\r\n\r\n`
    // blank line is recognised as a paragraph break and no stray `\r` leaks into the rendered output.
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: string[] = [];
  for (const block of blocks) {
    // Preserve multi-line blocks (bullet runs, deliberate line breaks) exactly as authored.
    if (/\n/.test(block)) {
      out.push(block);
      continue;
    }
    const sentences = splitSentences(block);
    // Greedily group sentences into paragraphs bounded by sentence count AND character budget.
    let current: string[] = [];
    let currentLen = 0;
    for (const sentence of sentences) {
      const projected = currentLen + (current.length > 0 ? 1 : 0) + sentence.length;
      if (
        current.length > 0 &&
        (current.length >= MAX_SENTENCES_PER_PARAGRAPH || projected > SOFT_CHAR_LIMIT)
      ) {
        out.push(current.join(' '));
        current = [];
        currentLen = 0;
      }
      current.push(sentence);
      currentLen += (currentLen > 0 ? 1 : 0) + sentence.length;
    }
    if (current.length > 0) out.push(current.join(' '));
  }
  return out;
}

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
      // Slot-aware rendering: choice answers show their respondent-facing labels (not stored option
      // keys) and booleans honour their configured true/false labels — the same shared formatter the
      // PDF and on-screen panel use, so the report transcript can't drift from what the respondent saw.
      lines.push(`A: ${formatSlotAnswer(slot.type, slot.typeConfig, slot.value)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
