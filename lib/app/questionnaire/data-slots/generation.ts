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

/** Build the structured-generation prompt. Output is JSON (parsed by the capability). */
export function buildDataSlotGenerationPrompt(structure: DataSlotStructureInput): LlmMessage[] {
  const system =
    'You design the DATA SLOTS for a conversational questionnaire. A data slot is a short ' +
    '(1–4 word) semantic target — a single meaningful thing we want to learn — with a one or ' +
    'two sentence description of what it captures and why it matters. Data slots are the ' +
    'abstraction layer over the raw questions: a skilled interviewer fills them naturally in ' +
    'conversation, and filling them well answers the underlying questions.\n\n' +
    'Rules:\n' +
    '- Each slot maps to one OR MORE questions (by their key) that it meaningfully captures. ' +
    'Prefer consolidating several related questions into one well-described slot over a 1:1 copy.\n' +
    '- Cover every question: each question key must be referenced by at least one slot.\n' +
    '- Give each slot a short `theme` (a grouping label shared by related slots) so the ' +
    'respondent panel can group them.\n' +
    '- Names are 1–4 words, human and concrete (e.g. "Onboarding ease", "Time to value"). ' +
    'Descriptions explain what a good answer reveals.\n' +
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
