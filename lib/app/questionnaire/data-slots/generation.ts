/**
 * Pure prompt builder + validator for the data-slot generator capability.
 *
 * Given a version's approved questions (plus goal/audience), the generator infers a small set
 * of semantic data slots — short names + descriptions + which question(s) each abstracts over.
 * The conversation later targets these slots; filling them well answers the questions. No
 * Prisma / Next imports here (the capability under `lib/app/**` stays pure).
 */

import { z } from 'zod';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  dataSlotGenerationOutputSchema,
  type DataSlotGenerationOutput,
  type DataSlotStructureInput,
} from '@/lib/app/questionnaire/data-slots/schemas';
import {
  DEFAULT_DATA_SLOT_GRANULARITY,
  granularityGuidance,
  type DataSlotGranularity,
} from '@/lib/app/questionnaire/data-slots/granularity';

/**
 * Build the structured-generation prompt. Output is JSON (parsed by the capability).
 * `granularity` tunes how many slots the model aims for and how broad/fine each is.
 */
export function buildDataSlotGenerationPrompt(
  structure: DataSlotStructureInput,
  granularity: DataSlotGranularity = DEFAULT_DATA_SLOT_GRANULARITY
): LlmMessage[] {
  const system =
    'You design the DATA SLOTS for a conversational questionnaire. A data slot is a short ' +
    '(1–4 word) semantic target — a single meaningful thing we want to learn — paired with a ' +
    'DETAILED description of what it captures and why it matters. Data slots are the abstraction ' +
    'layer over the raw questions: a skilled interviewer fills them naturally in conversation, ' +
    'and filling them well answers the underlying questions.\n\n' +
    `GRANULARITY for this set: ${granularityGuidance(granularity)}\n\n` +
    'Rules:\n' +
    '- Each slot maps to one OR MORE questions (by their key) that it meaningfully captures.\n' +
    '- Cover every question: each question key must be referenced by at least one slot.\n' +
    '- Give each slot a short `theme` (a grouping label shared by related slots) so the ' +
    'respondent panel can group them.\n' +
    '- Names are 1–4 words, human and concrete (e.g. "Onboarding ease", "Time to value").\n' +
    '- DESCRIPTIONS ARE CRITICAL — they are the brief the interviewer works from, so they must ' +
    'carry the FULL intent of the question(s) the slot abstracts over. Write 3–5 sentences ' +
    '(up to ~900 characters) that: (a) state precisely what information the slot must capture, ' +
    'naming every distinct sub-aspect of the underlying question(s); (b) explain why it matters ' +
    'and what a complete, high-quality answer reveals; (c) note what would leave the answer ' +
    'incomplete or which follow-ups to probe for. When you consolidate several questions into one ' +
    'slot, the description MUST still cover each of their intents — never drop detail to keep it ' +
    'short. A reader must be able to tell, from the description alone, exactly what to ask about.\n' +
    'Reply with JSON only: { "slots": [ { "name", "description", "theme", "questionKeys": [...], ' +
    '"confidence": 0..1 } ] }. No prose, no markdown.';

  const lines = structure.questions.map(
    (q) =>
      `- [${q.key}] (${q.type}${q.sectionTitle ? `, section: ${q.sectionTitle}` : ''}) ${q.prompt}`
  );
  const user =
    (structure.goal ? `Questionnaire goal: ${structure.goal}\n\n` : '') +
    `Questions (${structure.questions.length}):\n${lines.join('\n')}\n\n` +
    'Design the data slots now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Retry nudge (user-message text) when the first response wasn't valid JSON / schema. */
export function buildDataSlotRetryMessage(): string {
  return (
    'Your previous reply was not valid. Reply with ONLY the JSON object ' +
    '{ "slots": [ { "name", "description", "theme", "questionKeys": [...], "confidence" } ] } ' +
    'and nothing else.'
  );
}

export type DataSlotValidation =
  | { ok: true; value: DataSlotGenerationOutput }
  | { ok: false; issues: z.ZodIssue[] };

/** Validate a parsed generator response against the output schema. */
export function validateDataSlotGeneration(parsed: unknown): DataSlotValidation {
  const result = dataSlotGenerationOutputSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
