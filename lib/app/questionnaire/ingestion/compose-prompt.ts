/**
 * Prompt builders for generative authoring (compose-from-brief + refine).
 *
 * Pure and provider-agnostic: every function returns `LlmMessage[]` with no
 * provider/SDK import. The capabilities and the streaming orchestrator hand these
 * to whatever provider the composer agent resolves to. As with the extractor, the
 * stable contract is the *structure* of the messages (a system rule set + a user
 * payload), not the exact wording.
 *
 * Two-phase streaming uses {@link buildComposeOutlinePrompt} then, per section,
 * {@link buildComposeSectionQuestionsPrompt}; the single-shot capability uses
 * {@link buildComposeFullPrompt}; a refine turn uses {@link buildRefineStructurePrompt}.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  QUESTION_TYPES,
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import {
  adminSuppliedFieldPaths,
  type BuildExtractionPromptInput,
} from '@/lib/app/questionnaire/ingestion/extraction-prompt';
import type { ComposeStructure } from '@/lib/app/questionnaire/ingestion/compose-schema';

type AdminSupplied = BuildExtractionPromptInput['adminSupplied'];

/** Shared persona for every generative-authoring call. */
const COMPOSER_PERSONA = `You are an expert questionnaire designer. From a short plain-English brief you \
compose a clean, well-structured conversational questionnaire: coherent sections, clear \
self-contained questions, and a sensible answer type for each. You are decisive and concise — \
no boilerplate, no filler, no duplicate questions. Prefer the smallest set of questions that \
fully covers the brief's intent over an exhaustive one.`;

/** The do-not-infer instruction shared with the extractor's suppression rule. */
function suppressionLine(adminSupplied: AdminSupplied): string {
  const suppressed = adminSuppliedFieldPaths(adminSupplied);
  return suppressed.length > 0
    ? `The admin has already set these fields — do NOT infer or override them: ${suppressed.join(', ')}. ` +
        `You may still infer any audience field not in that list.`
    : `The admin supplied no goal or audience — infer both from the brief.`;
}

/** The JSON spec for a single question object — shared across the full/section prompts. */
const QUESTION_SHAPE = `{
  "sectionOrdinal": <integer matching a section's "ordinal">,
  "key": "<stable unique slug, snake_case>",
  "prompt": "<the question text shown to the respondent — REQUIRED>",
  "suggestedType": "<one of: ${QUESTION_TYPES.join(' | ')}>",
  "suggestedTypeConfig": { <choice: {"choices":["A","B"]}; likert: {"min":1,"max":5,"labels":["…","…","…","…","…"]} — required for likert> },
  "guidelines": "<optional answering guidance>",
  "rationale": "<optional why-this-question>",
  "extractionConfidence": <number between 0 and 1; your confidence the question fits the brief>
}`;

const AUDIENCE_SHAPE = `{
  "description": "<optional string>",
  "role": "<optional string>",
  "expertiseLevel": "<optional, one of: ${AUDIENCE_EXPERTISE_LEVELS.join(' | ')}>",
  "estimatedDurationMinutes": <optional positive integer>,
  "locale": "<optional BCP-47 tag, e.g. 'en'>",
  "sensitivity": "<optional, one of: ${AUDIENCE_SENSITIVITY_LEVELS.join(' | ')}>",
  "notes": "<optional string>"
}`;

/** Common tail rule for every prompt: JSON only, no nulls, required fields. */
const JSON_ONLY = `Respond with ONLY a single JSON object — no prose, no code fences. Omit any optional \
field entirely rather than sending null. "prompt" and "suggestedType" are REQUIRED on every question.`;

/** Shared scale rule: likert points must be labelled; numeric ratings stay numeric. */
const SCALE_RULE = `For a "likert" question, ALWAYS set "suggestedTypeConfig" to integer "min" and \
"max" plus a "labels" array with one short human-readable label per point (ordered min→max, length \
exactly max − min + 1). The labels MUST read naturally as an answer to THIS question's wording — \
choose the family that fits the stem, do NOT default to agree/disagree: agreement → "Strongly \
disagree → Strongly agree"; extent/degree ("to what extent…", "how much…") → "Not at all → To a \
very great extent"; frequency ("how often…") → "Never → Always"; satisfaction → "Very dissatisfied \
→ Very satisfied"; quality ("how would you rate…") → "Very poor → Excellent"; likelihood → "Very \
unlikely → Very likely"; importance → "Not at all important → Extremely important". Interpolate \
evenly for the in-between points. These labels are shown in the final report instead of a bare \
number. Use "likert" only when each point has a qualitative meaning; for a purely numeric rating \
(e.g. "rate 0–10", a count) use "numeric", which needs no labels.`;

// ---------------------------------------------------------------------------
// Phase 1 — outline (sections + inferred goal/audience)
// ---------------------------------------------------------------------------

const OUTLINE_SYSTEM = `${COMPOSER_PERSONA}

Plan the questionnaire's SHAPE only — its sections and overall framing. Do NOT write questions yet.

Output a JSON object with EXACTLY these keys:
{
  "sections": [
    { "ordinal": <integer ≥ 0, contiguous from 0>, "title": "<short section title>", "description": "<optional one-line purpose>" }
  ],
  "inferredGoal": "<optional string — the questionnaire's overall goal>",
  "inferredAudience": ${AUDIENCE_SHAPE}
}

Design 2–7 sections that together cover the brief. Order them in the sequence a respondent should \
encounter them. ${JSON_ONLY}`;

export function buildComposeOutlinePrompt(
  brief: string,
  adminSupplied?: AdminSupplied
): LlmMessage[] {
  return [
    { role: 'system', content: OUTLINE_SYSTEM },
    {
      role: 'user',
      content: `${suppressionLine(adminSupplied)}\n\n--- BEGIN BRIEF ---\n${brief}\n--- END BRIEF ---`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 2 — questions for one section
// ---------------------------------------------------------------------------

export interface ComposeSectionContext {
  ordinal: number;
  title: string;
  description?: string;
  /** Titles of every section, for context so questions don't bleed across sections. */
  siblingTitles: string[];
  goal?: string;
}

const SECTION_SYSTEM = `${COMPOSER_PERSONA}

Write the questions for ONE section of a questionnaire. Cover that section's purpose with the \
fewest, clearest questions you can. Every question's "sectionOrdinal" MUST equal the given \
section's ordinal. Keep keys unique within this section (snake_case).

Output a JSON object with EXACTLY this key:
{ "questions": [ ${QUESTION_SHAPE} ] }

${SCALE_RULE}

${JSON_ONLY}`;

export function buildComposeSectionQuestionsPrompt(
  brief: string,
  section: ComposeSectionContext
): LlmMessage[] {
  const header = [
    section.goal ? `Questionnaire goal: ${section.goal}` : null,
    `All sections (for context): ${section.siblingTitles.join(' · ')}`,
    `Write questions for THIS section only — ordinal ${section.ordinal}: "${section.title}"${
      section.description ? ` (${section.description})` : ''
    }.`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: SECTION_SYSTEM },
    {
      role: 'user',
      content: `${header}\n\n--- BEGIN BRIEF ---\n${brief}\n--- END BRIEF ---`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Single-shot — whole structure in one call (the API-accessible capability)
// ---------------------------------------------------------------------------

const FULL_SYSTEM = `${COMPOSER_PERSONA}

Compose the COMPLETE questionnaire from the brief — sections and all their questions.

Output a JSON object with EXACTLY these keys:
{
  "sections": [
    { "ordinal": <integer ≥ 0, contiguous from 0>, "title": "<short section title>", "description": "<optional>" }
  ],
  "questions": [ ${QUESTION_SHAPE} ],
  "inferredGoal": "<optional string>",
  "inferredAudience": ${AUDIENCE_SHAPE}
}

Design 2–7 sections; every question's "sectionOrdinal" must match a declared section "ordinal"; \
question keys must be unique across the whole questionnaire (snake_case).

${SCALE_RULE}

${JSON_ONLY}`;

export function buildComposeFullPrompt(brief: string, adminSupplied?: AdminSupplied): LlmMessage[] {
  return [
    { role: 'system', content: FULL_SYSTEM },
    {
      role: 'user',
      content: `${suppressionLine(adminSupplied)}\n\n--- BEGIN BRIEF ---\n${brief}\n--- END BRIEF ---`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Refine — apply an instruction to an existing structure
// ---------------------------------------------------------------------------

const REFINE_SYSTEM = `${COMPOSER_PERSONA}

You are refining an EXISTING questionnaire structure. Apply the admin's instruction and return the \
FULL updated structure (not a diff) plus a one-line summary of what you changed. Preserve everything \
the instruction does not touch — keep existing question "key" values stable where a question is kept, \
so answers stay aligned. Keys must remain unique (snake_case); every question's "sectionOrdinal" must \
match a declared section "ordinal".

Output a JSON object with EXACTLY these keys:
{
  "structure": {
    "sections": [ { "ordinal": <integer ≥ 0, contiguous from 0>, "title": "<string>", "description": "<optional>" } ],
    "questions": [ ${QUESTION_SHAPE} ],
    "inferredGoal": "<optional string>",
    "inferredAudience": ${AUDIENCE_SHAPE}
  },
  "summary": "<one short sentence describing the change>"
}

${JSON_ONLY}`;

export function buildRefineStructurePrompt(
  currentStructure: ComposeStructure,
  instruction: string
): LlmMessage[] {
  return [
    { role: 'system', content: REFINE_SYSTEM },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        `--- BEGIN CURRENT STRUCTURE (JSON) ---\n${JSON.stringify(currentStructure)}\n` +
        `--- END CURRENT STRUCTURE ---`,
    },
  ];
}

/** Stricter retry message when a generative call fails schema validation. */
export function buildComposeRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return `Return ONLY the JSON object matching the specified shape exactly, using the exact field names.${detail}`;
}
