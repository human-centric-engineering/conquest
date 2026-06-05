/**
 * The answer refiner's structured-output contract (F4.4).
 *
 * The shape the LLM must return for one refinement pass — validated
 * deterministically with Zod, the same discipline as the extractor
 * (`extraction/extraction-schema.ts`) and the detector
 * (`contradiction/detection-schema.ts`): structural and enum checks live in Zod (not
 * the prompt), and a parse failure yields the full `issues` path list so the
 * capability's repair retry can name exactly what was wrong.
 *
 * SEMANTIC checks — does the `slotKey` name a real, *already-answered* slot; is the
 * `newValue` a legal answer for that slot's type; is the change a genuine one — are
 * deliberately kept OUT of Zod and enforced by `normalizeRefinementDecisions`, which
 * drops an individual bad decision rather than failing the whole pass (the F4.2
 * doctrine). `newValue` is therefore only optional-unknown here; the
 * refine/overwrite-requires-a-value rule is the normaliser's.
 *
 * Pure: Zod only, no Prisma / Next. The `action`/`source` enums derive from the
 * `REFINEMENT_ACTIONS`/`REFINEMENT_SOURCES` tuples so there is one source of truth.
 */

import { z } from 'zod';

import { REFINEMENT_ACTIONS, REFINEMENT_SOURCES } from '@/lib/app/questionnaire/refinement/types';

/**
 * One LLM-reported refinement decision. STRUCTURAL checks (here, in Zod): a
 * non-empty `slotKey`, a valid `action`/`source`, a non-empty `rationale`,
 * `confidence` in range. `newValue` is open `unknown` (F1.1 discipline — the model
 * emits open JSON; per-type validity is checked downstream against the slot's real
 * config) and optional (only refine/overwrite need it; the normaliser enforces
 * that). SEMANTIC checks (slot existence / answered-ness / value validity / no-op)
 * live in `normalizeRefinementDecisions`.
 */
const refinementDecisionSchema = z.object({
  /** The slot to update (must resolve to an answered slot; checked downstream). */
  slotKey: z.string().min(1),
  /** refine | overwrite | leave. */
  action: z.enum(REFINEMENT_ACTIONS),
  /** The proposed new value — required for refine/overwrite (enforced downstream). */
  newValue: z.unknown().optional(),
  /** Why this change (or non-change), in plain language. */
  rationale: z.string().min(1),
  /** What prompted the change — labels the history entry. */
  source: z.enum(REFINEMENT_SOURCES),
  /** 0–1, how sure the refiner is the change is correct. */
  confidence: z.number().min(0).max(1),
});

/** Top-level refinement result: the per-slot decisions the model made this pass. */
export const refinementSchema = z.object({
  refinements: z.array(refinementDecisionSchema),
});

export type RefinementDecisionRaw = z.infer<typeof refinementDecisionSchema>;
export type Refinement = z.infer<typeof refinementSchema>;

/**
 * JSON-schema serialisation of {@link refinementSchema}, for a provider
 * `responseFormat` / structured-output request. Computed once at module load.
 */
export const refinementJsonSchema: Record<string, unknown> = z.toJSONSchema(refinementSchema, {
  unrepresentable: 'any',
});

/** Discriminated result of validating a parsed candidate against the contract. */
export type RefinementValidation =
  | { ok: true; value: Refinement }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link refinementSchema}. Returns
 * the typed value or the flat `issues` list (field path + message) — the capability
 * feeds those into its repair-retry prompt. Use with
 * `tryParseJson(raw, (p) => validateRefinement(p).ok ? … : null)`.
 */
export function validateRefinement(parsed: unknown): RefinementValidation {
  const result = refinementSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
