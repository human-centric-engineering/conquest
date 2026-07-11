/**
 * The contradiction detector's structured-output contract (F4.3).
 *
 * The shape the LLM must return for one detection pass — validated
 * deterministically with Zod, the same discipline as the extractor
 * (`extraction/extraction-schema.ts`): structural and enum checks live in Zod (not
 * the prompt), and a parse failure yields the full `issues` path list so the
 * capability's repair retry can name exactly what was wrong.
 *
 * SEMANTIC checks — do the `slotKeys` name real, *answered* slots; is a pair a
 * duplicate of one already reported — are deliberately kept OUT of Zod and enforced
 * by `normalizeContradictionFindings`, which drops an individual bad finding rather
 * than failing the whole pass (the F4.2 doctrine: normalise/drop one odd item, not
 * the turn). `slotKeys` is therefore only required to be a non-empty array of
 * non-empty strings here; the ≥2-distinct-answered rule is the normaliser's.
 *
 * Pure: Zod only, no Prisma / Next. The `severity` enum derives from the
 * `CONTRADICTION_SEVERITIES` tuple so there is one source of truth.
 */

import { z } from 'zod';

import { CONTRADICTION_SEVERITIES } from '@/lib/app/questionnaire/contradiction/types';

/**
 * One LLM-reported contradiction. STRUCTURAL checks (here, in Zod): a non-empty
 * `slotKeys` list, a non-empty `explanation`, a valid `severity`, `confidence` in
 * range. SEMANTIC checks (slot existence / answered-ness / ≥2 distinct / dedupe)
 * live in `normalizeContradictionFindings`.
 */
const detectedContradictionSchema = z.object({
  /** The conflicting slot keys (must resolve to answered slots; checked downstream). */
  slotKeys: z.array(z.string().min(1)).min(1),
  /** Why the answers conflict, in plain language. */
  explanation: z.string().min(1),
  severity: z.enum(CONTRADICTION_SEVERITIES),
  confidence: z.number().min(0).max(1),
  /** A follow-up question to reconcile the conflict — kept only under `probe` mode. */
  suggestedProbe: z.string().optional(),
});

/** Top-level detection result: the contradictions the model found this pass. */
export const contradictionDetectionSchema = z.object({
  contradictions: z.array(detectedContradictionSchema),
});

export type DetectedContradiction = z.infer<typeof detectedContradictionSchema>;
export type ContradictionDetection = z.infer<typeof contradictionDetectionSchema>;

/**
 * JSON-schema serialisation of {@link contradictionDetectionSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 */
export const contradictionDetectionJsonSchema: Record<string, unknown> = z.toJSONSchema(
  contradictionDetectionSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type ContradictionDetectionValidation =
  { ok: true; value: ContradictionDetection } | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link contradictionDetectionSchema}.
 * Returns the typed value or the flat `issues` list (field path + message) — the
 * capability feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateContradictionDetection(p).ok ? … : null)`.
 */
export function validateContradictionDetection(parsed: unknown): ContradictionDetectionValidation {
  const result = contradictionDetectionSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
