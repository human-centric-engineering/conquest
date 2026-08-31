/**
 * The extraction verifier's structured-output contract (ingest verify + repair).
 *
 * The verifier is a CRITIC: given the extracted questions plus the source document, it
 * returns a per-question verdict (ok / suspect + a reason) and, for any rating grid it
 * spots, the full grid span so the repair specialist can re-read it whole. It fixes
 * nothing — the orchestrator uses these flags to decide which questions to repair.
 *
 * Deliberately small output (flags, not rewrites): one structured call over all
 * questions stays cheap even for a long questionnaire. Coverage is checked by the
 * orchestrator (a key the verifier skips is treated as `ok`), so a dropped verdict can
 * never block a question.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

/** The ways an extracted question can be unfaithful to its source (drives the repair prompt). */
export const VERIFY_ISSUES = [
  'type_mismatch',
  'missing_likert_anchors',
  'matrix_flattened',
  'matrix_rows_lost',
  'config_invalid',
  'not_a_question',
  'other',
] as const;
export type VerifyIssue = (typeof VERIFY_ISSUES)[number];

/**
 * The one issue that is not a repair job.
 *
 * Every other value here says "this question was read wrongly, re-read it". This one says the
 * span is not a question at all: interviewer script, a transition, an instruction about how to
 * answer, a note to the operator. There is nothing for the scales/matrix specialist to correct,
 * because no answer type makes a line like "Based on what you've said I want to go deeper on the
 * areas below" into something a respondent can answer.
 *
 * So the orchestrator handles it itself, by DROPPING the question and filing a revertible
 * `prune_question` change, and never sends it to repair. Named here rather than spelled inline at
 * the two call sites so the drop path and the prompt cannot drift apart from the enum.
 */
export const NOT_A_QUESTION_ISSUE: VerifyIssue = 'not_a_question';

export const questionVerdictSchema = z.object({
  /** The extracted question's key (must be one from the input set). */
  key: z.string().min(1),
  verdict: z.enum(['ok', 'suspect']),
  /** Present when `suspect` — what's wrong (guides the repair pass). */
  issue: z.enum(VERIFY_ISSUES).optional(),
  /** One short line for logs and the repair prompt. */
  detail: z.string().optional(),
});
export type QuestionVerdict = z.infer<typeof questionVerdictSchema>;

const matrixGroupHintSchema = z.object({
  /** The grid's heading, e.g. "How important are the following?" */
  label: z.string().min(1),
  /** The FULL grid block text (rows + shared scale) so repair can re-read the whole grid. */
  sourceSpanQuote: z.string().min(1),
  /** Keys of already-extracted questions that belong to this grid (empty if it was flattened into one). */
  memberKeys: z.array(z.string()).default([]),
});
export type MatrixGroupHint = z.infer<typeof matrixGroupHintSchema>;

/**
 * What the critic concluded about the question COUNT, as opposed to any individual question.
 *
 * Added because the critic had no way to notice the one thing it most needed to: on a run of
 * routing-corpus doc 02 it checked all 28 extracted questions, flagged 3 sensibly, and never
 * remarked that the source had 22 numbered items. Every per-question verdict can be `ok` while the
 * question SET is wrong — a compound split in two, a stray heading promoted to a question, a page
 * of the source missed entirely. Per-question faithfulness simply cannot see any of those.
 *
 * `uncountable` is a first-class answer and should be the common one: plenty of instruments do not
 * number their questions, and a guessed count is worse than an honest shrug. Only a document that
 * states its own count — through numbering, an explicit "20 questions", or a complete visible list
 * — supports anything else.
 */
export const coverageSchema = z.object({
  /** The count the SOURCE claims, when it says. Null whenever `assessment` is `uncountable`. */
  sourceQuestionCount: z.number().int().nonnegative().nullable(),
  assessment: z.enum(['matches', 'extra_questions', 'missing_questions', 'uncountable']),
  /** One line naming the discrepancy — which questions look invented, or which look missed. */
  detail: z.string().optional(),
});
export type VerifyCoverage = z.infer<typeof coverageSchema>;

export const verifyResultSchema = z.object({
  verdicts: z.array(questionVerdictSchema),
  matrixGroups: z.array(matrixGroupHintSchema).default([]),
  /**
   * Optional so an older verifier reply (or one that omits it) still parses — the same fail-soft
   * posture the rest of the ingest chain uses. A missing coverage read is "not assessed", never a
   * reason to discard verdicts that are otherwise good.
   */
  coverage: coverageSchema.optional(),
});
export type VerifyResult = z.infer<typeof verifyResultSchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const verifyJsonSchema: Record<string, unknown> = z.toJSONSchema(verifyResultSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type VerifyValidation =
  { ok: true; value: VerifyResult } | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link verifyResultSchema}. */
export function validateVerifyResult(parsed: unknown): VerifyValidation {
  const result = verifyResultSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
