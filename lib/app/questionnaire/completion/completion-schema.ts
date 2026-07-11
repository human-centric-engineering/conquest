/**
 * The completion-offer's structured-output contract (F4.5).
 *
 * The shape the LLM must return when composing the offer-to-submit message —
 * validated deterministically with Zod, the same discipline as the extractor and
 * detector: structural checks live in Zod (not the prompt), and a parse failure
 * yields the full `issues` path list so the capability's repair retry can name
 * exactly what was wrong.
 *
 * There are no SEMANTIC checks to defer here (unlike the detector's slot-key
 * resolution): the offer is free-text the agent speaks, so the contract is purely
 * structural — a non-empty offer message, a non-empty covered recap, and an optional
 * note on what remains.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

/** The completion offer the model composes — the "agent contract". */
export const completionOfferSchema = z.object({
  /** The message the agent says to offer submission. */
  offerMessage: z.string().min(1),
  /** A short recap of what's been covered, to frame the offer. */
  coveredSummary: z.string().min(1),
  /** An optional note on what remains optional/skippable. */
  remainingNote: z.string().optional(),
});

export type CompletionOfferOutput = z.infer<typeof completionOfferSchema>;

/**
 * JSON-schema serialisation of {@link completionOfferSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 */
export const completionOfferJsonSchema: Record<string, unknown> = z.toJSONSchema(
  completionOfferSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type CompletionOfferValidation =
  { ok: true; value: CompletionOfferOutput } | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link completionOfferSchema}.
 * Returns the typed value or the flat `issues` list (field path + message) — the
 * capability feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateCompletionOffer(p).ok ? … : null)`.
 */
export function validateCompletionOffer(parsed: unknown): CompletionOfferValidation {
  const result = completionOfferSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
