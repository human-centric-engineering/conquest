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
  'other',
] as const;
export type VerifyIssue = (typeof VERIFY_ISSUES)[number];

const questionVerdictSchema = z.object({
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

export const verifyResultSchema = z.object({
  verdicts: z.array(questionVerdictSchema),
  matrixGroups: z.array(matrixGroupHintSchema).default([]),
});
export type VerifyResult = z.infer<typeof verifyResultSchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const verifyJsonSchema: Record<string, unknown> = z.toJSONSchema(verifyResultSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type VerifyValidation =
  | { ok: true; value: VerifyResult }
  | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link verifyResultSchema}. */
export function validateVerifyResult(parsed: unknown): VerifyValidation {
  const result = verifyResultSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
