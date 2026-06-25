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
}

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
"max", length exactly (max − min + 1). Example for a 1–5 satisfaction scale: \
{"min": 1, "max": 5, "labels": ["Very dissatisfied","Dissatisfied","Neutral","Satisfied","Very satisfied"]}. \
These labels are what the final report shows instead of a bare number. If the source gives only \
endpoint anchors, infer sensible labels for the points in between.
- Use "likert" ONLY when each point carries a qualitative meaning. If a question asks for a \
purely numeric rating with no qualitative scale (e.g. "rate 0–10", a count, an age, a percentage), \
use "numeric" instead — numeric questions need no labels.
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

  return [
    { role: 'system', content: SYSTEM_RULES },
    {
      role: 'user',
      content: `${header}\n\n--- BEGIN QUESTIONNAIRE DOCUMENT ---\n${input.documentText}\n--- END QUESTIONNAIRE DOCUMENT ---`,
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
