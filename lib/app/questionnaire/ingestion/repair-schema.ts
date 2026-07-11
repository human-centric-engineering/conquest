/**
 * The question-repair specialist's structured-output contract (ingest verify + repair).
 *
 * Given a small set of flagged questions + the source, the repair agent returns corrected
 * questions — reusing the extractor's {@link extractedQuestionSchema} so there is ONE
 * question shape end to end. Each repair names the original key(s) it addresses and an
 * action:
 *  - `correct` → replace one question in place (may change its type, e.g. → `matrix`).
 *  - `merge`   → collapse several mis-split per-row questions into ONE `matrix` question.
 *
 * The orchestrator (`mergeRepairs`) owns the guarded merge: a repaired config is accepted
 * only if it validates strictly better, else the original is kept (never worse).
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { extractedQuestionSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';

const repairSchema = z.object({
  /** The flagged question key(s) this repair replaces (1 for `correct`, ≥1 for `merge`). */
  originalKeys: z.array(z.string().min(1)).min(1),
  action: z.enum(['correct', 'merge']),
  /** The corrected question(s): 1 for `correct`, exactly 1 (the merged matrix) for `merge`. */
  questions: z.array(extractedQuestionSchema).min(1),
  rationale: z.string().optional(),
});
export type QuestionRepair = z.infer<typeof repairSchema>;

export const repairResultSchema = z.object({
  repairs: z.array(repairSchema),
});
export type RepairResult = z.infer<typeof repairResultSchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const repairJsonSchema: Record<string, unknown> = z.toJSONSchema(repairResultSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type RepairValidation =
  | { ok: true; value: RepairResult }
  | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link repairResultSchema}. */
export function validateRepairResult(parsed: unknown): RepairValidation {
  const result = repairResultSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
