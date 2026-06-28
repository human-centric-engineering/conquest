/**
 * Prompt builder for the questionnaire extractor (F1.1 / PR2).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with
 * no provider/SDK import. The capability (PR3) hands these to whatever provider
 * the extractor agent resolves to. Authored as a real prompt, but the stable
 * contract this module owns is the *structure* — a system rules message + a user
 * message carrying the document and the admin's do-not-infer list — not the exact
 * wording, which is free to evolve.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  QUESTION_TYPES,
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import {
  CHANGE_TYPES,
  TARGET_ENTITY_TYPES,
  type AdminSuppliedMetadata,
} from '@/lib/app/questionnaire/ingestion/types';

export interface BuildExtractionPromptInput {
  /** Plain text the parser extracted from the upload (what the model reads). */
  documentText: string;
  fileName: string;
  mediaType?: string;
  /** Fields the admin already set — the model must NOT infer these. */
  adminSupplied?: AdminSuppliedMetadata;
  /**
   * Free-text steering the admin attached to this upload. Guidance the model
   * applies while extracting (e.g. "questions are in the Activities tab",
   * "replace 'HPE' with a generic term") — it does not change the output
   * contract. Injected inside a clearly-delimited block, with fence delimiters
   * neutralised so the text can't break out of it.
   */
  adminInstructions?: string;
}

/**
 * File extensions whose parsed text is a flattened spreadsheet (tab-per-table).
 * Deliberately a SUPERSET of the questionnaire upload allowlist (which today is
 * `.xlsx` only): the guidance is harmless prose if a format is never accepted,
 * and listing the obvious tabular formats means adding `.csv`/`.xls` to the
 * allowlist later won't silently ship them without spreadsheet guidance. NOTE:
 * the upload pipeline only routes `.xlsx` through `flattenWorkbook`; adding
 * another format here also requires a flatten/parse branch in `extract-pipeline.ts`.
 */
const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/**
 * Neutralise Markdown fence delimiters in admin-supplied text so a pasted (or
 * malicious) `--- END ADMIN INSTRUCTIONS ---` / document fence can't close the
 * surrounding block early and smuggle a peer instruction or a fake document into
 * the prompt. Any line whose first non-space characters are 3+ hyphens has them
 * swapped for an em-dash — inert prose, never a fence.
 */
function neutralizeFences(text: string): string {
  return text.replace(/^[ \t]*-{3,}/gm, '—');
}

/** True when the upload is a spreadsheet, by file-name extension (case-insensitive). */
function isSpreadsheet(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SPREADSHEET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Heuristics (NOT rules) the model applies when the document is a flattened
 * spreadsheet. A workbook is often relational rather than linear: one tab holds
 * the questions, others hold the section/scoring/metadata they reference. These
 * lines tell the model how to read that — it still decides what is actually a
 * question, and the admin's instructions override any guess.
 */
const SPREADSHEET_GUIDANCE = `This document is a faithful dump of a spreadsheet: each \
"## Sheet: <name>" block is one tab, rendered as a Markdown table with its first row as \
headers. Read it as structured data, not prose:
- Tabs usually relate to each other through shared ID / code columns (a value in one tab's \
column reappears as a reference column in another). Follow those links to attach each \
question to the right section/group.
- Typically ONE tab holds the actual questions (often the longest column of sentence-like \
text) while other tabs hold supporting data: section names, descriptions, scoring, or \
campaign metadata. Use the supporting tabs to name and group sections — do not emit their \
rows as questions.
- ID, code, order, and weighting columns are structure, not question text. Never turn them \
into questions.
- A column that looks like an internal on/off flag (e.g. "Include", "Active") may be mostly \
off across the sheet; do not silently drop rows because of it unless the admin instructions \
or an unambiguous signal says to.
- A "type" column (e.g. likertscale, comment) is a strong hint for each question's answer \
type — map it onto the allowed types.`;

/**
 * Dotted paths of the metadata fields an admin supplied, e.g. `['goal',
 * 'audience.role']`. Drives the prompt's do-not-infer instruction and mirrors
 * the suppression `normalizeChangeRecords` applies — kept here as one function
 * so prompt and normaliser agree on what "supplied" means (presence, including
 * empty string; `undefined` = not supplied).
 */
export function adminSuppliedFieldPaths(meta: AdminSuppliedMetadata | undefined): string[] {
  if (!meta) return [];
  const paths: string[] = [];
  if (meta.goal !== undefined) paths.push('goal');
  if (meta.audience) {
    for (const [key, value] of Object.entries(meta.audience)) {
      if (value !== undefined) paths.push(`audience.${key}`);
    }
  }
  return paths;
}

const SYSTEM_RULES = `You are an opinionated questionnaire-structuring assistant. You convert a raw \
questionnaire document into a clean, structured form for a conversational survey tool. \
You are editorial, not literal: improve the questionnaire while preserving its intent.

Editorial decisions you SHOULD make:
- Prune boilerplate (headers, footers, "for office use only", page numbers, legal filler).
- Correct spelling and grammar in prompts.
- Rewrite terse or ambiguous prompts into clear, self-contained questions.
- Infer each question's answer type from one of: ${QUESTION_TYPES.join(', ')}.
- For a "likert" scale, ALWAYS include in "suggestedTypeConfig": integer "min" and "max", \
and a "labels" array with one short human-readable label per point — in order from "min" to \
"max", length exactly (max − min + 1). These labels are what the respondent picks from and what \
the final report shows instead of a bare number, so they MUST read naturally as an answer to THIS \
question's wording. Choose the label family that fits the question's stem — do NOT default to \
agree/disagree:
  · agreement ("…it is true that…", a statement to endorse) → "Strongly disagree → Strongly agree"
  · extent / degree ("to what extent…", "how much…") → "Not at all","To a small extent","To a moderate extent","To a great extent","To a very great extent"
  · frequency ("how often…", "how regularly…") → "Never","Rarely","Sometimes","Often","Always"
  · satisfaction ("how satisfied…") → "Very dissatisfied → Very satisfied"
  · quality / performance ("how would you rate…") → "Very poor → Excellent"
  · likelihood ("how likely…") → "Very unlikely → Very likely"
  · importance ("how important…") → "Not at all important → Extremely important"
These are illustrative ramps for a 1–5 scale — adapt the wording to the question and interpolate \
evenly for other lengths. If the source already gives anchor wording, follow it and infer sensible \
in-between points. When no family clearly fits, use a neutral intensity ramp ("Very low → Very high") \
rather than forcing agreement.
- Use "likert" ONLY when each point carries a qualitative meaning. If a question asks for a \
purely numeric rating with no qualitative scale (e.g. "rate 0–10", a count, an age, a percentage), \
use "numeric" instead — numeric questions need no labels.
- For a "free_text" question, set "suggestedTypeConfig.commentAggregation": "section" when the \
question is a SECTION-WIDE comment that should reflect the whole section's discussion (e.g. "Please \
provide comments to support your scores", "Any other comments on this section?", "Anything else \
about the above?"); otherwise "isolated" for a self-contained free-text question (e.g. "What is your \
job title?", "Describe your biggest challenge"). When unsure, use "isolated".
- Merge duplicate questions; split a compound question into separate ones.
- Add a section to group loose questions when the document implies one.
- Infer the questionnaire's overall goal and its intended audience.
- Mark a question "required": true ONLY when the source explicitly flags it mandatory \
(an asterisk "*", "(required)", "mandatory", "must be completed", a "Required" column, …). \
This is a faithful read of the document, NOT a judgement call — omit "required" when the \
source gives no such signal. Do not emit a change entry for it.

Conservative default: when you are unsure whether a span is real content or \
boilerplate, KEEP it. A pruned question is recoverable; a silently dropped one the \
author remembers is the worse failure.

Accountability — this is mandatory:
- Record EVERY editorial decision as one entry in "changes", each with a "changeType" \
(one of: ${CHANGE_TYPES.join(', ')}), the "targetEntityType" it affects \
(section, question, or version), a short "rationale", and a "sourceQuote" of the \
original span where one exists.
- A question you carry through verbatim, with no edit, produces NO change entry.
- For prune_section / prune_question, put the removed content in "beforeJson" and leave \
"afterJson" null — the prune must be reversible.
- For infer_goal / infer_audience, set "targetEntityType" to "version" and put the \
inferred value in "afterJson".

Output: respond with ONLY a single JSON object — no prose, no code fences — with \
these top-level keys, using EXACTLY these field names:

{
  "sections": [
    { "ordinal": <integer ≥ 0>, "title": "<string>", "description": "<string, optional>" }
  ],
  "questions": [
    {
      "sectionOrdinal": <integer matching a section's "ordinal">,
      "key": "<stable unique slug>",
      "prompt": "<the question text shown to the respondent — REQUIRED>",
      "suggestedType": "<one of: ${QUESTION_TYPES.join(' | ')}>",
      "suggestedTypeConfig": { <choice: {"choices":["A","B"]}; likert: {"min":1,"max":5,"labels":["…","…","…","…","…"]} — required for likert> },
      "guidelines": "<optional answering guidance>",
      "rationale": "<optional why-this-question>",
      "extractionConfidence": <number between 0 and 1>,
      "sourceQuote": "<optional original span>",
      "required": <optional boolean — true only when the source marks the field mandatory>
    }
  ],
  "inferredGoal": "<optional string>",
  "inferredAudience": {
    "description": "<optional string>",
    "role": "<optional string>",
    "expertiseLevel": "<optional, one of: ${AUDIENCE_EXPERTISE_LEVELS.join(' | ')}>",
    "estimatedDurationMinutes": <optional positive integer>,
    "locale": "<optional BCP-47 tag, e.g. 'en'>",
    "sensitivity": "<optional, one of: ${AUDIENCE_SENSITIVITY_LEVELS.join(' | ')}>",
    "notes": "<optional string>"
  },
  "changes": [
    {
      "changeType": "<one of: ${CHANGE_TYPES.join(' | ')}>",
      "targetEntityType": "<one of: ${TARGET_ENTITY_TYPES.join(' | ')}>",
      "rationale": "<short string>",
      "sourceQuote": "<optional original span>",
      "beforeJson": <optional>,
      "afterJson": <optional>,
      "confidence": <optional number between 0 and 1>
    }
  ]
}

"prompt" and "suggestedType" are REQUIRED on every question — never omit them or \
rename them. Omit any optional field entirely rather than sending null. "inferredGoal" \
and "inferredAudience" are themselves optional; omit them if you cannot infer them.`;

/**
 * Build the system + user messages for one extraction call. The system message
 * is the fixed rule set; the user message carries the document (with its file
 * metadata) and — when the admin pre-set fields — an explicit instruction to
 * leave those fields uninferred and emit no inference change record for them.
 */
export function buildExtractionPrompt(input: BuildExtractionPromptInput): LlmMessage[] {
  const suppressed = adminSuppliedFieldPaths(input.adminSupplied);

  const skipInstruction =
    suppressed.length > 0
      ? `The admin has already set these fields — do NOT infer them and do NOT emit an ` +
        `infer_goal/infer_audience change for them: ${suppressed.join(', ')}. You may still ` +
        `infer any audience field not in that list.`
      : `The admin supplied no goal or audience — infer both.`;

  const header = [
    `File: ${input.fileName}`,
    input.mediaType ? `Media type: ${input.mediaType}` : null,
    skipInstruction,
  ]
    .filter(Boolean)
    .join('\n');

  // Spreadsheet reading heuristics — only when the upload is a flattened workbook.
  const spreadsheetBlock = isSpreadsheet(input.fileName) ? `\n\n${SPREADSHEET_GUIDANCE}` : '';

  // Admin steering — fenced so the model treats it as trusted instructions from
  // the operator, distinct from the document content it must extract. It guides
  // extraction but cannot override the required output shape.
  const instructions = input.adminInstructions?.trim();
  const adminBlock =
    instructions && instructions.length > 0
      ? `\n\n--- BEGIN ADMIN INSTRUCTIONS (apply these; they do not change the required output format) ---\n${neutralizeFences(instructions)}\n--- END ADMIN INSTRUCTIONS ---`
      : '';

  return [
    { role: 'system', content: SYSTEM_RULES },
    {
      role: 'user',
      content: `${header}${spreadsheetBlock}${adminBlock}\n\n--- BEGIN QUESTIONNAIRE DOCUMENT ---\n${input.documentText}\n--- END QUESTIONNAIRE DOCUMENT ---`,
    },
  ];
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix
 * the named fields.
 */
export function buildExtractionRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object with the required keys ("sections", "questions", "changes", ` +
    `and optionally "inferredGoal"/"inferredAudience"), matching the specified shape exactly.` +
    detail
  );
}
