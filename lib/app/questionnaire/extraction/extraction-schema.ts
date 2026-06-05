/**
 * The answer-extractor's structured-output contract (F4.2).
 *
 * The shape the LLM must return for one turn — validated deterministically with
 * Zod, the same discipline as the ingestion extractor (`ingestion/extraction-schema.ts`):
 * structural and enum checks live in Zod (not the prompt), and a parse failure
 * yields the full `issues` path list so the capability's repair retry can name
 * exactly what was wrong.
 *
 * `value` is deliberately `z.unknown()` — per-type correctness (a single_choice
 * value being one of the slot's options, a likert within bounds) needs the slot's
 * runtime `typeConfig`, which a static schema can't see. That semantic check lives
 * downstream in `answer-value.ts` + `answer-intents.ts`, which normalise or drop
 * an individual odd answer rather than failing the whole turn. The `provenance`
 * enum is the F4.2-emittable subset (`refined` is the F4.4 refinement flow's).
 *
 * Pure: Zod only, no Prisma / Next. Enums derive from the `const` tuples in
 * `../types.ts` so there is one source of truth.
 */

import { z } from 'zod';

import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';

/**
 * One LLM-reported answer. STRUCTURAL checks (here, in Zod): `slotKey` present,
 * `confidence` in range, `provenance` a valid emittable label. SEMANTIC checks —
 * does `value` fit the slot's type and config, does `slotKey` name a real
 * candidate — are deliberately kept OUT of Zod and enforced by
 * `normalizeAnswerIntents`, which drops an individual bad answer instead of
 * failing the whole turn.
 */
const extractedAnswerSchema = z.object({
  /** The stable slot slug this answers (must resolve to a candidate; checked downstream). */
  slotKey: z.string().min(1),
  /** The answer value — typed per the slot's QuestionType; validated downstream. */
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  provenance: z.enum(EXTRACTOR_EMITTED_PROVENANCES),
  rationale: z.string(),
  /** The message span the value came from — required-by-convention for `direct`. */
  sourceQuote: z.string().optional(),
});

/** Top-level extraction result: the answers the model found in this turn. */
export const answerExtractionSchema = z.object({
  answers: z.array(extractedAnswerSchema),
});

export type ExtractedAnswer = z.infer<typeof extractedAnswerSchema>;
export type AnswerExtraction = z.infer<typeof answerExtractionSchema>;

/**
 * JSON-schema serialisation of {@link answerExtractionSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 * The `z.unknown()` `value` serialises to an open `{}` (any JSON), which is the
 * intended contract.
 */
export const answerExtractionJsonSchema: Record<string, unknown> = z.toJSONSchema(
  answerExtractionSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type AnswerExtractionValidation =
  | { ok: true; value: AnswerExtraction }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link answerExtractionSchema}.
 * Returns the typed value or the flat `issues` list (field path + message) — the
 * capability feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateAnswerExtraction(p).ok ? … : null)`.
 */
export function validateAnswerExtraction(parsed: unknown): AnswerExtractionValidation {
  const result = answerExtractionSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
