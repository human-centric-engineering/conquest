/**
 * The judge's structured-output contract (F5.1).
 *
 * Every judge — whichever dimension — returns the same shape: a continuous `score` in
 * [0, 1] and a list of actionable `findings`. Validated deterministically with Zod
 * (the extractor / detector / completion discipline): structural checks live here, not
 * in the prompt, and a parse failure yields the full `issues` path list so the
 * capability's repair retry can name exactly which fields were wrong.
 *
 * `dimension` is NOT part of this contract: the LLM scores and suggests, but the
 * caller stamps which dimension the verdict belongs to — a judge can't mislabel its
 * own output. The capability composes a {@link JudgeVerdict} from this output plus the
 * dimension it dispatched.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { FINDING_SEVERITIES, type ProposedEdit } from '@/lib/app/questionnaire/evaluation/types';
import { QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';

/**
 * Upper bound on findings per judge. A judge that wants to flag more than this on one
 * dimension is almost certainly mis-scoring (or the structure is enormous); the cap
 * keeps a runaway response from bloating the review queue and the prompt round-trip.
 */
export const MAX_FINDINGS_PER_JUDGE = 50;

/** Field-length caps — generous enough for a real suggestion, bounded against abuse. */
const TARGET_KEY_MAX = 200;
const PROPOSED_CHANGE_MAX = 2_000;
const RATIONALE_MAX = 2_000;
const SOURCE_QUOTE_MAX = 2_000;
/** Caps on the structured-edit text fields, mirroring the prose caps above. */
const EDIT_TEXT_MAX = 2_000;

/**
 * The structured `proposedEdit` contract (F5.3) — a discriminated union on `op` mirroring
 * {@link ProposedEdit}. `typeConfig` stays `unknown` (validated against the *effective*
 * type by `validateTypeConfig` at apply time, the `createQuestionSchema` posture — a
 * static schema can't express the type↔config coupling). `audience` reuses the ingestion
 * audience shape (all-optional) as the merge-patch. This schema is **not** sent to the
 * provider; it parses and validates the model's prompt-guided JSON (see `coerceProposedEdit`).
 */
export const proposedEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_prompt'), prompt: z.string().min(1).max(EDIT_TEXT_MAX) }),
  z.object({
    op: z.literal('edit_guidelines'),
    guidelines: z.string().min(1).max(EDIT_TEXT_MAX).nullable(),
  }),
  z.object({
    op: z.literal('change_type'),
    type: z.enum(QUESTION_TYPES),
    typeConfig: z.unknown().optional(),
  }),
  z.object({ op: z.literal('delete_question') }),
  z.object({
    op: z.literal('reorder'),
    ordinal: z.number().int().nonnegative(),
    targetSectionKey: z.string().min(1).max(TARGET_KEY_MAX).optional(),
  }),
  z.object({ op: z.literal('edit_goal'), goal: z.string().min(1).max(EDIT_TEXT_MAX) }),
  z.object({ op: z.literal('edit_audience'), audience: audienceShapeSchema }),
  z.object({
    op: z.literal('add_question'),
    prompt: z.string().min(1).max(EDIT_TEXT_MAX),
    type: z.enum(QUESTION_TYPES),
    sectionKey: z.string().min(1).max(TARGET_KEY_MAX).optional(),
    guidelines: z.string().min(1).max(EDIT_TEXT_MAX).optional(),
    typeConfig: z.unknown().optional(),
  }),
]);

/**
 * Compile-time parity guard: the schema's inferred output must stay mutually assignable to the
 * hand-written {@link ProposedEdit} union in `types.ts` (which the apply engine switches on). If a
 * schema member and the type drift, `_ParityCheck` resolves to `false` and the `const` annotation
 * below stops type-checking. Type-only — no runtime function (keeps the module's coverage clean).
 */
export type ProposedEditOutput = z.infer<typeof proposedEditSchema>;
type _ParityCheck<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _proposedEditParity: _ParityCheck<ProposedEditOutput, ProposedEdit> = true;
void _proposedEditParity;

/**
 * Soft-degrade a raw `proposedEdit` value to a validated {@link ProposedEdit} or `null`.
 * Run at the persist/read seam so one malformed op never sinks the surrounding verdict or
 * finding — the `parseAudienceShape` posture. A finding whose op degrades to `null`
 * becomes prose-only (the admin gets the guided editor, not a broken one-click apply).
 */
export function coerceProposedEdit(raw: unknown): ProposedEdit | null {
  if (raw === null || raw === undefined) return null;
  const parsed = proposedEditSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** One actionable finding the judge proposes. `proposedEdit` is optional (prose-only ok). */
export const judgeFindingSchema = z.object({
  targetKey: z.string().min(1).max(TARGET_KEY_MAX),
  severity: z.enum(FINDING_SEVERITIES),
  proposedChange: z.string().min(1).max(PROPOSED_CHANGE_MAX),
  rationale: z.string().min(1).max(RATIONALE_MAX),
  sourceQuote: z.string().max(SOURCE_QUOTE_MAX).optional(),
  proposedEdit: proposedEditSchema.optional(),
});

/** The raw judge output — score + findings. `dimension` is added by the caller. */
export const judgeVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  findings: z.array(judgeFindingSchema).max(MAX_FINDINGS_PER_JUDGE),
});

/** The validated raw output (no `dimension` — that's the caller's to stamp). */
export type JudgeVerdictOutput = z.infer<typeof judgeVerdictSchema>;

/**
 * JSON-schema serialisation of {@link judgeVerdictSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 */
export const judgeVerdictJsonSchema: Record<string, unknown> = z.toJSONSchema(judgeVerdictSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type JudgeVerdictValidation =
  | { ok: true; value: JudgeVerdictOutput }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link judgeVerdictSchema}. Returns
 * the typed value or the flat `issues` list (field path + message) — the capability
 * feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateJudgeVerdict(p).ok ? … : null)`.
 */
export function validateJudgeVerdict(parsed: unknown): JudgeVerdictValidation {
  const result = judgeVerdictSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
