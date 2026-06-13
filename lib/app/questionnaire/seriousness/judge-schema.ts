/**
 * Seriousness judge — the structured LLM output contract (pure Zod).
 *
 * The judge returns a single verdict: is this answer a genuine attempt? Kept deliberately
 * minimal (a boolean + a short reason) — unlike contradiction detection there's no multi-slot
 * normalisation, just a ruling. The invoker validates the model's JSON against this before
 * acting on it.
 */

import { z } from 'zod';

/** Max length of the judge's reason — a short, respondent-safe sentence, not prose. */
export const SERIOUSNESS_REASON_MAX = 400;

export const seriousnessVerdictSchema = z.object({
  /** `true` = genuine attempt (incl. colloquial/lazy); `false` = abuse/ridiculous/off-topic. */
  serious: z.boolean(),
  /** A short, polite reason the answer reads as non-genuine (empty when serious). */
  reason: z.string().max(SERIOUSNESS_REASON_MAX).default(''),
});

export type SeriousnessVerdictRaw = z.infer<typeof seriousnessVerdictSchema>;

/** Validate parsed JSON against the verdict schema, returning the issues on failure. */
export function validateSeriousnessVerdict(
  parsed: unknown
): { ok: true; value: SeriousnessVerdictRaw } | { ok: false; issues: z.ZodIssue[] } {
  const result = seriousnessVerdictSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
