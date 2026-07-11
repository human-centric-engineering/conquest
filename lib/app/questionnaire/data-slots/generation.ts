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
  dataSlotAssignmentOutputSchema,
  dataSlotGenerationOutputSchema,
  dataSlotRefinementOutputSchema,
  type AssignExistingSlot,
  type DataSlotAssignmentOutput,
  type DataSlotGenerationOutput,
  type DataSlotRefinementOutput,
  type DataSlotStructureInput,
  type RefineInputSlot,
} from '@/lib/app/questionnaire/data-slots/schemas';
import {
  DEFAULT_DATA_SLOT_GRANULARITY,
  granularityGuidance,
  targetSlotRange,
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
  const { min, max } = targetSlotRange(granularity, structure.questions.length);
  const system =
    'You design the DATA SLOTS for a conversational questionnaire. A data slot is a short ' +
    '(1–4 word) semantic target — a single meaningful thing we want to learn — paired with a ' +
    'DETAILED description of what it captures and why it matters. Data slots are the abstraction ' +
    'layer over the raw questions: a skilled interviewer fills them naturally in conversation, ' +
    'and filling them well answers the underlying questions.\n\n' +
    `GRANULARITY for this set: ${granularityGuidance(granularity)}\n` +
    `TARGET COUNT: aim for roughly ${min}–${max} slots across these ` +
    `${structure.questions.length} question(s) — consolidate related questions to hit that range. ` +
    'Treat it as a strong target, not a hard cap: only deviate when the content genuinely demands it.\n\n' +
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
  const { min, max } = targetSlotRange(granularity, structure.questions.length);
  const system =
    'You are RECONCILING data slots for a conversational questionnaire. Independent passes over ' +
    'each section proposed the candidate slots below; your job is to merge them into ONE coherent ' +
    'final set. A data slot is a short (1–4 word) semantic target with a DETAILED description.\n\n' +
    `GRANULARITY for the final set: ${granularityGuidance(granularity)}\n` +
    `TARGET COUNT: the final set should contain roughly ${min}–${max} slots for the ` +
    `${structure.questions.length} questions. The per-section candidates below are almost ` +
    'certainly too many — merge related ones across sections to reach that range. Treat it as a ' +
    'strong target, not a hard cap.\n\n' +
    'Rules:\n' +
    '- Merge duplicates AND related slots across sections into a single slot, unioning their ' +
    'question keys, to reach the target count. Keep genuinely distinct slots separate.\n' +
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

/**
 * Build the REFINE prompt: rewrite ONE existing data slot per the admin's free-text instructions.
 * The model sees the slot as it stands, the instructions, and the version's full question list (so
 * it can re-suggest which questions the slot covers — "wording + coverage" scope), plus the other
 * slots' names/themes so it keeps the theme consistent and doesn't duplicate a sibling. Output is
 * the single refined slot as JSON (same shape as one generated slot), parsed by the capability.
 */
export function buildDataSlotRefinementPrompt(
  structure: DataSlotStructureInput,
  slot: RefineInputSlot,
  instructions: string,
  siblingSlots: { name: string; theme: string }[] = []
): LlmMessage[] {
  const system =
    'You REFINE a single DATA SLOT for a conversational questionnaire. A data slot is a short ' +
    '(1–4 word) semantic target — a single meaningful thing we want to learn — paired with a ' +
    'DETAILED description of what it captures and why it matters, plus the question(s) it ' +
    'abstracts over. A skilled interviewer fills it naturally in conversation.\n\n' +
    'You are given ONE existing slot, the admin’s refinement instructions, and the full question ' +
    'set. Apply the instructions to produce an improved version of THIS slot only.\n\n' +
    'Rules:\n' +
    '- Follow the admin’s instructions faithfully; otherwise preserve the slot’s intent.\n' +
    '- You MAY change the name, description, theme, AND which questions it covers — re-map ' +
    '`questionKeys` to the questions this refined slot genuinely captures (use the keys from the ' +
    'question list; drop any that no longer fit, add any that now do). Keep at least one key when ' +
    'a sensible match exists.\n' +
    '- Name is 1–4 words, human and concrete (e.g. "Onboarding ease", "Time to value").\n' +
    '- Keep the `theme` consistent with the related slots listed below unless the instructions ask ' +
    'otherwise — theme is a shared grouping label.\n' +
    '- Do NOT duplicate another slot listed below; stay a distinct target.\n' +
    '- DESCRIPTION IS CRITICAL — it is the brief the interviewer works from. Write 3–5 sentences ' +
    '(up to ~900 characters) that: (a) state precisely what information the slot must capture, ' +
    'naming every distinct sub-aspect of the question(s) it covers; (b) explain why it matters and ' +
    'what a complete, high-quality answer reveals; (c) note what would leave the answer incomplete ' +
    'or which follow-ups to probe for.\n' +
    'Reply with JSON only: { "slot": { "name", "description", "theme", "questionKeys": [...], ' +
    '"confidence": 0..1 } }. No prose, no markdown.';

  const questionLines = structure.questions.map(
    (q) =>
      `- [${q.key}] (${q.type}${q.sectionTitle ? `, section: ${q.sectionTitle}` : ''}) ${q.prompt}`
  );
  const siblingLines = siblingSlots.map((s) => `- "${s.name}" [theme: ${s.theme}]`);
  const user =
    (structure.goal ? `Questionnaire goal: ${structure.goal}\n\n` : '') +
    'Slot to refine:\n' +
    `- name: ${slot.name || '(empty)'}\n` +
    `- theme: ${slot.theme || '(empty)'}\n` +
    `- currently covers: ${slot.questionKeys.join(', ') || '(none)'}\n` +
    `- description: ${slot.description || '(empty)'}\n\n` +
    `Refinement instructions:\n${instructions}\n\n` +
    (siblingLines.length > 0
      ? `Other slots in this set (keep distinct, harmonize theme):\n${siblingLines.join('\n')}\n\n`
      : '') +
    `All questions (${structure.questions.length}):\n${questionLines.join('\n')}\n\n` +
    'Produce the refined slot now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the ASSIGN prompt: place one or more NEW (unslotted) questions into the existing data-slot
 * set. For each new question the model decides whether it belongs in an existing slot (by its stable
 * `key`) or needs a new slot. It does NOT rewrite existing slots — the route's deterministic merge
 * does the writing, so this call only emits placements. Output is JSON parsed by the capability.
 */
export function buildDataSlotAssignmentPrompt(
  structure: DataSlotStructureInput,
  existingSlots: AssignExistingSlot[],
  orphanQuestionKeys: string[]
): LlmMessage[] {
  const system =
    'You maintain the DATA SLOTS for a conversational questionnaire. A data slot is a short ' +
    '(1–4 word) semantic target — a single meaningful thing we want to learn — with a detailed ' +
    'description and the question(s) it abstracts over. The questionnaire already has a set of ' +
    'data slots; some NEW questions were added afterwards and are not yet covered by any slot.\n\n' +
    'For EACH new question, decide where it belongs:\n' +
    '- Prefer an EXISTING slot when the question captures the SAME data point as that slot ' +
    '(return that slot’s `key`). A question can extend a slot that already spans related questions.\n' +
    '- Create a NEW slot only when the question is a genuinely distinct data point no existing slot ' +
    'covers. Give it a 1–4 word human `name` in Title or sentence case (e.g. "Current morale", ' +
    '"Time to value") — NOT a snake_case key like "current_morale"; match the style of the existing ' +
    'slot names above. Add a short `theme` (reuse an existing theme when it fits) and a DETAILED ' +
    '`description` (3–5 sentences) stating exactly what to capture and why it matters.\n' +
    '- If two new questions are the same distinct data point, give them the SAME new slot `name` ' +
    'so they merge into one slot.\n' +
    'Return one placement for EVERY new question — never drop one.\n' +
    'Reply with JSON only: { "placements": [ { "questionKey", "target": ' +
    '{ "kind": "existing", "slotKey" } | { "kind": "new", "name", "description", "theme" } } ] }. ' +
    'No prose, no markdown.';

  const slotLines = existingSlots.map(
    (s) =>
      `- [key: ${s.key}] "${s.name}" [theme: ${s.theme}] (covers: ${
        s.questionKeys.join(', ') || 'none'
      }) — ${s.description}`
  );
  const byKey = new Map(structure.questions.map((q) => [q.key, q]));
  const orphanLines = orphanQuestionKeys.map((key) => {
    const q = byKey.get(key);
    return q
      ? `- [${q.key}] (${q.type}${q.sectionTitle ? `, section: ${q.sectionTitle}` : ''}) ${q.prompt}`
      : `- [${key}] (question not found)`;
  });
  const user =
    (structure.goal ? `Questionnaire goal: ${structure.goal}\n\n` : '') +
    `Existing data slots (${existingSlots.length}):\n${slotLines.join('\n') || '(none)'}\n\n` +
    `New questions to place (${orphanQuestionKeys.length}):\n${orphanLines.join('\n')}\n\n` +
    'Place every new question now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Retry nudge (user-message text) when an assign response wasn't valid JSON / schema. */
export function buildDataSlotAssignmentRetryMessage(): string {
  return (
    'Your previous reply was not valid. Reply with ONLY the JSON object ' +
    '{ "placements": [ { "questionKey", "target": { "kind": "existing", "slotKey" } | ' +
    '{ "kind": "new", "name", "description", "theme" } } ] } and nothing else.'
  );
}

/** Retry nudge (user-message text) when a refine response wasn't valid JSON / schema. */
export function buildDataSlotRefinementRetryMessage(): string {
  return (
    'Your previous reply was not valid. Reply with ONLY the JSON object ' +
    '{ "slot": { "name", "description", "theme", "questionKeys": [...], "confidence" } } ' +
    'and nothing else.'
  );
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
  { ok: true; value: DataSlotGenerationOutput } | { ok: false; issues: z.ZodIssue[] };

/** Validate a parsed generator response against the output schema. */
export function validateDataSlotGeneration(parsed: unknown): DataSlotValidation {
  const result = dataSlotGenerationOutputSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

export type DataSlotRefinementValidation =
  { ok: true; value: DataSlotRefinementOutput } | { ok: false; issues: z.ZodIssue[] };

/** Validate a parsed refine response ({ slot }) against the refinement output schema. */
export function validateDataSlotRefinement(parsed: unknown): DataSlotRefinementValidation {
  const result = dataSlotRefinementOutputSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

export type DataSlotAssignmentValidation =
  { ok: true; value: DataSlotAssignmentOutput } | { ok: false; issues: z.ZodIssue[] };

/** Validate a parsed assign response ({ placements }) against the assignment output schema. */
export function validateDataSlotAssignment(parsed: unknown): DataSlotAssignmentValidation {
  const result = dataSlotAssignmentOutputSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
