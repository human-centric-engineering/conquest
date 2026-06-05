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

import { FINDING_SEVERITIES } from '@/lib/app/questionnaire/evaluation/types';

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

/** One actionable finding the judge proposes. */
export const judgeFindingSchema = z.object({
  targetKey: z.string().min(1).max(TARGET_KEY_MAX),
  severity: z.enum(FINDING_SEVERITIES),
  proposedChange: z.string().min(1).max(PROPOSED_CHANGE_MAX),
  rationale: z.string().min(1).max(RATIONALE_MAX),
  sourceQuote: z.string().max(SOURCE_QUOTE_MAX).optional(),
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
