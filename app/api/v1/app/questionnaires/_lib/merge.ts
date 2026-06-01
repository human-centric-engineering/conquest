/**
 * Goal/audience merge with per-field provenance (F1.1 / PR4, T1.4.2).
 *
 * The admin-wins-per-field rule from the F1.1 plan: for each of `goal` and every
 * `audience` field, pick the **admin-supplied** value if present, else the
 * **inferred** value, else any **pre-existing** value, else leave the field
 * absent. A re-ingest never blanks a previously-set field (the `pre-existing`
 * arm). Each resolved field is tagged with where its value came from so the route
 * can return P2-ready provenance.
 *
 * Pure: no Prisma / Next.js — `executeTransaction` in `persist.ts` consumes the
 * merged values; this stays unit-testable in isolation.
 */

import { AUDIENCE_FIELDS, type AudienceShape } from '@/lib/app/questionnaire/types';

/** Where a resolved goal/audience field's value came from. */
export type FieldProvenance = 'admin-supplied' | 'inferred' | 'pre-existing';

/** Per-field provenance tags for the merged values (UI-ready for P2). */
export interface MergeProvenance {
  /** Omitted when no goal was resolved from any source. */
  goal?: FieldProvenance;
  /** One entry per resolved audience field; absent fields are omitted. */
  audience: Partial<Record<keyof AudienceShape, FieldProvenance>>;
}

export interface MergeGoalAudienceResult {
  /** Resolved goal, or `null` when no source provided one. */
  goal: string | null;
  /** Resolved audience, or `null` when no field was resolved. */
  audience: AudienceShape | null;
  provenance: MergeProvenance;
}

export interface MergeGoalAudienceInput {
  /** Admin-supplied values (admin wins). A trimmed-empty value is treated as absent upstream. */
  admin?: { goal?: string; audience?: Partial<AudienceShape> };
  /** Values the extractor inferred (used only where the admin didn't supply). */
  inferred?: { goal?: string; audience?: Partial<AudienceShape> };
  /** Values already on the version (a fresh ingest has none; F2.4 re-ingest will). */
  existing?: { goal?: string | null; audience?: Partial<AudienceShape> | null };
}

/** Resolve one scalar field across the admin → inferred → existing precedence. */
function resolveField<T>(
  admin: T | undefined,
  inferred: T | undefined,
  existing: T | undefined | null
): { value: T; provenance: FieldProvenance } | null {
  if (admin !== undefined) return { value: admin, provenance: 'admin-supplied' };
  if (inferred !== undefined) return { value: inferred, provenance: 'inferred' };
  if (existing !== undefined && existing !== null) {
    return { value: existing, provenance: 'pre-existing' };
  }
  return null;
}

/**
 * Merge admin-supplied, inferred, and pre-existing goal/audience values into the
 * values to persist plus their per-field provenance. See module doc.
 */
export function mergeGoalAudience(input: MergeGoalAudienceInput): MergeGoalAudienceResult {
  const provenance: MergeProvenance = { audience: {} };

  const goalResolved = resolveField(input.admin?.goal, input.inferred?.goal, input.existing?.goal);
  const goal = goalResolved ? goalResolved.value : null;
  if (goalResolved) provenance.goal = goalResolved.provenance;

  const audience: AudienceShape = {};
  for (const field of AUDIENCE_FIELDS) {
    const resolved = resolveField(
      input.admin?.audience?.[field],
      input.inferred?.audience?.[field],
      input.existing?.audience?.[field]
    );
    if (!resolved) continue;
    // Each audience field is independently typed in AudienceShape; assigning the
    // resolved value (same source key) preserves that type without a cast.
    Object.assign(audience, { [field]: resolved.value });
    provenance.audience[field] = resolved.provenance;
  }

  return {
    goal,
    audience: Object.keys(audience).length > 0 ? audience : null,
    provenance,
  };
}
