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

/**
 * Build the MERGE/REDUCE prompt: reconcile slot candidates produced by independent
 * per-section passes into one coherent final set. The map step generates slots section
 * by section (so no single call has to emit everything); this step dedupes near-duplicates
 * across sections, guarantees full question coverage, harmonizes themes, and honours the
 * granularity — the cross-section view a single section pass can't have.
 */
export function buildDataSlotMergePrompt(
  structure: DataSlotStructureInput,
  candidates: { name: string; description: string; theme: string; questionKeys: string[] }[],
  granularity: DataSlotGranularity = DEFAULT_DATA_SLOT_GRANULARITY
): LlmMessage[] {
  const system =
    'You are RECONCILING data slots for a conversational questionnaire. Independent passes over ' +
    'each section proposed the candidate slots below; your job is to merge them into ONE coherent ' +
    'final set. A data slot is a short (1–4 word) semantic target with a DETAILED description.\n\n' +
    `GRANULARITY for the final set: ${granularityGuidance(granularity)}\n\n` +
    'Rules:\n' +
    '- Merge duplicates and near-duplicates across sections into a single slot, unioning their ' +
    'question keys. Keep genuinely distinct slots separate.\n' +
    '- Cover every question: each question key listed below must be referenced by at least one ' +
    'final slot. Add a slot if the candidates missed one.\n' +
    '- Harmonize `theme` labels so related slots share one grouping label.\n' +
    '- Names are 1–4 words, human and concrete.\n' +
    '- DESCRIPTIONS ARE CRITICAL — preserve the FULL intent when merging: the merged description ' +
    'must cover every sub-aspect of the candidates and questions it now spans (3–5 sentences, up ' +
    'to ~900 chars). Never drop detail to keep it short.\n' +
    'Reply with JSON only: { "slots": [ { "name", "description", "theme", "questionKeys": [...], ' +
    '"confidence": 0..1 } ] }. No prose, no markdown.';

  const questionLines = structure.questions.map(
    (q) =>
      `- [${q.key}] (${q.type}${q.sectionTitle ? `, section: ${q.sectionTitle}` : ''}) ${q.prompt}`
  );
  const candidateLines = candidates.map(
    (c, i) =>
      `${i + 1}. "${c.name}" [theme: ${c.theme}] (covers: ${
        c.questionKeys.join(', ') || 'none'
      }) — ${c.description}`
  );
  const user =
    (structure.goal ? `Questionnaire goal: ${structure.goal}\n\n` : '') +
    `All questions (${structure.questions.length}):\n${questionLines.join('\n')}\n\n` +
    `Candidate slots from the per-section passes (${candidates.length}):\n${candidateLines.join(
      '\n'
    )}\n\n` +
    'Produce the reconciled final set now.';

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

/**
 * Turn a raw structured-completion failure into a specific diagnostic code + a human,
 * actionable message — so the admin surface says *why* generation failed (truncated output
 * vs. timeout vs. bad shape) instead of a generic "generation failed". Pure (string in/out);
 * shared by the single-shot capability and the streaming map-reduce orchestrator.
 */
export function classifyGenerationFailure(
  raw: string,
  issuePaths: string[]
): { code: string; message: string } {
  const lower = raw.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
    return {
      code: 'generation_timeout',
      message:
        'The generator timed out. Large questionnaires with detailed descriptions can exceed the ' +
        'time limit — try a broader granularity (fewer, higher-level slots) and run it again.',
    };
  }

  // The retry-exhausted path: empty issuePaths means the JSON itself didn't parse (usually the
  // response was cut off mid-array); non-empty means it parsed but didn't match the schema.
  if (lower.includes('not valid against the schema')) {
    if (issuePaths.length === 0) {
      return {
        code: 'incomplete_response',
        message:
          'The model returned an incomplete or non-JSON response — it was likely cut off before ' +
          'finishing. Try a broader granularity so it produces fewer, shorter slots, then retry.',
      };
    }
    return {
      code: 'invalid_response',
      message: `The model's response didn't match the expected shape (issues at: ${issuePaths.join(
        ', '
      )}). Try again.`,
    };
  }

  return {
    code: 'generation_failed',
    message: raw || 'Data-slot generation failed unexpectedly. Try again.',
  };
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
