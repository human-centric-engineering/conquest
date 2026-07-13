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

/** One web-search finding surfaced in the report's Research / Sources section. */
export interface RespondentReportResearchFinding {
  /** Human-readable title (linked to `url` in the renderers). */
  title: string;
  /** The source URL — always a validated `http(s)` link. */
  url: string;
  /** Short description / excerpt of what was found. */
  snippet: string;
  /** Optional source label (e.g. site name) when the agent supplies one. */
  source?: string;
}

/**
 * How the research findings render — frozen into the report at generation time (a snapshot; the config
 * enum also has `hidden`, but a hidden report simply carries no research block). Renderers read this so
 * they don't need the version config.
 */
export type RespondentReportResearchDisplay = 'table' | 'list';

/** The web-research block folded into a report when web-search rounds ran (optional; legacy rows omit). */
export interface RespondentReportResearch {
  /** The retrieved findings, rendered as a table or list per {@link display}. */
  findings: RespondentReportResearchFinding[];
  /** Optional synthesis prose the research agent wrote about the findings. */
  note?: string;
  /** Table or list presentation, frozen from config at generation. Defaults to `list` on read. */
  display: RespondentReportResearchDisplay;
}

/** The generated insights payload (the `content` column for a mode-2 report). */
export interface RespondentReportContent {
  /** A short overview paragraph. */
  summary: string;
  /** Titled analysis sections. */
  sections: RespondentReportSection[];
  /** Concrete, actionable next steps the respondent can take. */
  actions: string[];
  /**
   * Web-search findings surfaced in the report, when web-search rounds ran and `display !== 'hidden'`.
   * Optional and additive — legacy reports and reports generated without research have none.
   */
  research?: RespondentReportResearch;
}

/**
 * Below this completion percentage a report is flagged as based on a partially-complete questionnaire
 * and rendered with a caveat subtitle (see {@link partialReportCaveat}). A report generated at or above
 * this threshold carries no caveat.
 */
export const PARTIAL_REPORT_THRESHOLD_PCT = 75;

/**
 * The caveat subtitle for a report generated from a partially-complete questionnaire, or `null` when
 * completion is at/above {@link PARTIAL_REPORT_THRESHOLD_PCT} (or unknown — legacy rows store `null`).
 * Deterministic and rendered identically on-screen and in the PDF — the exact percentage and wording
 * must not be entrusted to an LLM, so this is computed, never generated.
 */
export function partialReportCaveat(completionPct: number | null | undefined): string | null {
  if (completionPct == null || completionPct >= PARTIAL_REPORT_THRESHOLD_PCT) return null;
  return (
    `This is an AI-generated report based on a partially complete questionnaire (${completionPct}% ` +
    `complete) and may therefore contain AI-generated inaccuracies. For a comprehensive and reliable ` +
    `report, complete the full questionnaire.`
  );
}

/** Bounds — keep a report readable and a runaway model in check. */
export const REPORT_SUMMARY_MAX = 4000;
export const REPORT_SECTION_HEADING_MAX = 200;
export const REPORT_SECTION_BODY_MAX = 6000;
export const REPORT_ACTION_MAX = 1000;
export const REPORT_MAX_SECTIONS = 12;
export const REPORT_MAX_ACTIONS = 12;

/** Bounds on the web-research block folded into a report. */
export const REPORT_MAX_RESEARCH_FINDINGS = 25;
export const REPORT_RESEARCH_TITLE_MAX = 300;
export const REPORT_RESEARCH_URL_MAX = 2000;
export const REPORT_RESEARCH_SNIPPET_MAX = 2000;
export const REPORT_RESEARCH_SOURCE_MAX = 200;
export const REPORT_RESEARCH_NOTE_MAX = 4000;

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
 *
 * `trustParagraphs` (set for reports produced by the Report Formatter second pass) runs pass 1 only:
 * the formatter has already laid the prose out at natural boundaries, so honour its blank-line breaks
 * and bullet runs verbatim and skip the greedy sentence re-grouping that would otherwise re-chop a
 * deliberate 4-sentence paragraph. Un-formatted / legacy content leaves it off and gets the full split.
 */
export function splitReportParagraphs(
  text: string,
  opts: { trustParagraphs?: boolean } = {}
): string[] {
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
    // Trusted (formatter-produced) prose: keep each authored paragraph whole, no sentence re-grouping.
    if (opts.trustParagraphs) {
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
 * A finding's URL must be a syntactically-valid `http`/`https` link — findings are rendered as
 * clickable links, so a non-web scheme (`javascript:`, `data:`, `mailto:`) or garbage is dropped
 * rather than surfaced. Length-capped defensively.
 */
function validHttpUrl(value: unknown): string | null {
  const raw = trimTo(value, REPORT_RESEARCH_URL_MAX);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Narrow arbitrary parsed JSON onto a valid {@link RespondentReportResearch}, or `null` when there
 * is nothing usable (no finding with both a title and a valid URL). Malformed individual findings are
 * dropped, not fatal. Shared by generation (validating the research agent's digest) and the read path
 * (preserving the stored block through {@link validateRespondentReportContent}).
 */
export function validateResearch(parsed: unknown): RespondentReportResearch | null {
  if (!isRecord(parsed)) return null;

  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: RespondentReportResearchFinding[] = [];
  for (const entry of rawFindings) {
    if (findings.length >= REPORT_MAX_RESEARCH_FINDINGS) break;
    if (!isRecord(entry)) continue;
    const title = trimTo(entry.title, REPORT_RESEARCH_TITLE_MAX);
    const url = validHttpUrl(entry.url);
    if (!title || !url) continue;
    const snippet = trimTo(entry.snippet, REPORT_RESEARCH_SNIPPET_MAX) ?? '';
    const source = trimTo(entry.source, REPORT_RESEARCH_SOURCE_MAX);
    findings.push({ title, url, snippet, ...(source ? { source } : {}) });
  }

  const note = trimTo(parsed.note, REPORT_RESEARCH_NOTE_MAX);
  if (findings.length === 0 && !note) return null;
  const display: RespondentReportResearchDisplay = parsed.display === 'table' ? 'table' : 'list';
  return { findings, display, ...(note ? { note } : {}) };
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

  // Preserve a web-research block when the stored content carries one (attached post-generation in
  // `generate.ts`; the report agent's own JSON never has it). Load-bearing on the read path — this
  // validator re-narrows stored content in `view.ts`, so dropping it here would erase the section.
  const research = validateResearch(parsed.research);

  return { summary, sections, actions, ...(research ? { research } : {}) };
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
