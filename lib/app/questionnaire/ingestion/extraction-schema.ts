/**
 * The extractor's structured-output contract (F1.1 / PR2).
 *
 * This is the shape the LLM must return — validated deterministically with Zod,
 * the same discipline as the workflow `guard` step's schema mode: structural and
 * enum checks live in Zod (not the prompt), and a parse failure yields the full
 * `issues` path list so the capability's repair retry can name exactly what was
 * wrong. The persisted graph (`AppQuestionnaireSection`/`AppQuestionSlot`/…) is a
 * separate, storage-shaped concern — the route maps this contract onto it (PR4).
 *
 * Pure: Zod only, no Prisma / Next.js. The enums derive from the `const` tuples
 * in `../types.ts` and `./types.ts` so there is one source of truth.
 */

import { z } from 'zod';

import {
  QUESTION_TYPES,
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import { CHANGE_TYPES, TARGET_ENTITY_TYPES } from '@/lib/app/questionnaire/ingestion/types';

/** Arbitrary JSON config (choices, likert bounds, …) attached to a question. */
const typeConfigSchema = z.record(z.string(), z.unknown());

/** Inferred audience subset — every field optional (see `AudienceShape`). */
export const audienceShapeSchema = z
  .object({
    description: z.string(),
    role: z.string(),
    expertiseLevel: z.enum(AUDIENCE_EXPERTISE_LEVELS),
    estimatedDurationMinutes: z.number().int().positive(),
    locale: z.string(),
    sensitivity: z.enum(AUDIENCE_SENSITIVITY_LEVELS),
    notes: z.string(),
  })
  .partial();

const extractedSectionSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().optional(),
});

const extractedQuestionSchema = z.object({
  /** Links the question to its section by `ordinal` (no IDs exist pre-persist). */
  sectionOrdinal: z.number().int().nonnegative(),
  /** Stable per-version slug (answers/re-ingest reference this, not the cuid). */
  key: z.string().min(1),
  prompt: z.string().min(1),
  guidelines: z.string().optional(),
  rationale: z.string().optional(),
  suggestedType: z.enum(QUESTION_TYPES),
  suggestedTypeConfig: typeConfigSchema.optional(),
  extractionConfidence: z.number().min(0).max(1),
  sourceQuote: z.string().optional(),
});

/**
 * One LLM-reported editorial decision. Coherence BETWEEN fields (prune ⇒ no
 * `afterJson`, infer ⇒ version-targeted) and inference suppression are enforced
 * downstream by `normalizeChangeRecords` — kept out of Zod so a single odd record
 * doesn't fail the whole extraction (we normalise rather than reject).
 */
const extractedChangeSchema = z.object({
  changeType: z.enum(CHANGE_TYPES),
  targetEntityType: z.enum(TARGET_ENTITY_TYPES),
  sourceQuote: z.string().optional(),
  beforeJson: z.unknown().optional(),
  afterJson: z.unknown().optional(),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * Top-level extraction result. `inferredGoal`/`inferredAudience` are the values
 * the extractor proposes (suppressed per field by admin input); `changes` is the
 * editorial audit trail. Section/question `ordinal`s are the linking keys.
 */
export const extractionSchema = z.object({
  sections: z.array(extractedSectionSchema),
  questions: z.array(extractedQuestionSchema),
  inferredGoal: z.string().optional(),
  inferredAudience: audienceShapeSchema.optional(),
  changes: z.array(extractedChangeSchema),
});

export type ExtractedSection = z.infer<typeof extractedSectionSchema>;
export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>;
export type ExtractedChange = z.infer<typeof extractedChangeSchema>;
export type ExtractionResult = z.infer<typeof extractionSchema>;

/**
 * JSON-schema serialisation of {@link extractionSchema}, for a provider
 * `responseFormat` / structured-output request (PR3). Computed once at module
 * load. `z.unknown()` members serialise to an open `{}` (any JSON), which is the
 * intended contract for `beforeJson`/`afterJson`/`suggestedTypeConfig`.
 */
export const extractionJsonSchema: Record<string, unknown> = z.toJSONSchema(extractionSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type ExtractionValidation =
  | { ok: true; value: ExtractionResult }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link extractionSchema}.
 * Returns the typed value or the flat `issues` list (field path + message) —
 * the capability feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateExtraction(p).ok ? … : null)` in PR3.
 */
export function validateExtraction(parsed: unknown): ExtractionValidation {
  const result = extractionSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
