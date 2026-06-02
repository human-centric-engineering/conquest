/**
 * Shared glue for the authoring mutation routes (F2.1 / PR2).
 *
 * Small helpers every section/question/version mutation reuses: the
 * scope-and-404 version load, the success-`meta` shape carrying the fork outcome,
 * the per-version key resolver + collision mapper, the reorder permutation guard,
 * and the admin-supplied provenance stamp. Route-local DB seam (uses `prisma`).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/api/errors';
import {
  AUDIENCE_FIELDS,
  type AppQuestionnaireStatus,
  type AudienceProvenance,
  type AudienceShape,
  type FieldProvenance,
} from '@/lib/app/questionnaire/types';
import { nextAvailableKey, slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import type { ForkResult } from '@/app/api/v1/app/questionnaires/_lib/fork';

/**
 * Storage-boundary cast for a JSON column: null/undefined → SQL-NULL sentinel,
 * else opaque JSON. The input is already Zod-validated, so the cast is at the
 * Prisma boundary only (the same discipline as `_lib/persist.ts`).
 */
export function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value;
}

/** The minimal version facts a mutation route needs before it forks/writes. */
export interface ScopedVersion {
  id: string;
  questionnaireId: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
}

/**
 * Load a version scoped to its parent questionnaire. Returns `null` (→ route 404)
 * when the id/vid pair doesn't resolve, so a version can't leak across
 * questionnaires (the same scoping as `getVersionGraph`).
 */
export async function loadScopedVersion(
  questionnaireId: string,
  versionId: string
): Promise<ScopedVersion | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: { id: true, questionnaireId: true, versionNumber: true, status: true },
  });
  if (!version) return null;
  return {
    id: version.id,
    questionnaireId: version.questionnaireId,
    versionNumber: version.versionNumber,
    status: version.status as AppQuestionnaireStatus,
  };
}

/**
 * Translate a child id (`section`/`question`) targeted by the request URL into the
 * id to actually write. On the no-fork path the original id is already editable.
 * After a fork, the copy's id comes from the fork's old→new map; a missing entry
 * means the original id wasn't part of the version (a stale/cross-version id) —
 * surfaced as a 404.
 */
export function resolveForkedId(
  fork: ForkResult,
  kind: 'section' | 'question',
  originalId: string
): string | null {
  if (!fork.forked) return originalId;
  const map = kind === 'section' ? fork.sectionIdMap : fork.questionIdMap;
  return map?.get(originalId) ?? null;
}

/** Success-response `meta` carrying the fork outcome so the UI can notice + redirect. */
export function forkMeta(result: ForkResult): {
  forked: boolean;
  versionId: string;
  versionNumber: number;
} {
  return {
    forked: result.forked,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
  };
}

/**
 * Map a Prisma unique-constraint violation on `@@unique([versionId, key])` to a
 * field-keyed 400. Re-throws anything else unchanged. Call from a mutation's
 * catch when writing a slot key.
 */
export function asKeyConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ValidationError('Question key already in use in this version', {
      key: ['Key already in use in this version'],
    });
  }
  throw err;
}

/**
 * Resolve the `key` for a new/updated question. An explicit admin key is honoured
 * verbatim (a collision surfaces via {@link asKeyConflict}); an omitted key is
 * derived from the prompt and disambiguated against the version's existing keys.
 */
export async function resolveQuestionKey(
  versionId: string,
  explicitKey: string | undefined,
  prompt: string
): Promise<string> {
  if (explicitKey) return explicitKey;
  const existing = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    select: { key: true },
  });
  return nextAvailableKey(slugifyKey(prompt), new Set(existing.map((e) => e.key)));
}

/**
 * Validate that `orderedIds` is a permutation of exactly the current child ids,
 * then assign ordinals 0..n-1 via `setOrdinal` (sequentially — a Prisma
 * interactive transaction must not run concurrent queries). Throws a 400 when the
 * order isn't a clean permutation (stale/duplicate/missing id).
 */
export async function applyReorder(
  currentIds: readonly string[],
  orderedIds: readonly string[],
  setOrdinal: (id: string, ordinal: number) => Promise<unknown>
): Promise<void> {
  const current = new Set(currentIds);
  const proposed = new Set(orderedIds);
  const isPermutation =
    proposed.size === orderedIds.length && // no duplicates
    proposed.size === current.size &&
    orderedIds.every((id) => current.has(id));
  if (!isPermutation) {
    throw new ValidationError('Reorder must list each child exactly once', {
      order: ['Must be a permutation of the current children'],
    });
  }
  for (let i = 0; i < orderedIds.length; i += 1) {
    await setOrdinal(orderedIds[i], i);
  }
}

/**
 * Resolve audience provenance for a version-meta edit. The submitted audience
 * replaces the stored value wholesale, but provenance must flip to
 * `admin-supplied` **only for fields the admin actually changed** — a field
 * re-submitted with its existing value keeps its prior provenance. This is what
 * stops the editor (which carries the full audience in state but exposes only a
 * couple of inputs) from silently re-labelling extractor-`inferred` fields as
 * admin-supplied on every save. Fields absent from the new audience drop out.
 */
export function audienceProvenanceForEdit(
  next: AudienceShape,
  prevAudience: AudienceShape | null,
  prevProvenance: AudienceProvenance | null
): AudienceProvenance {
  const provenance: AudienceProvenance = {};
  for (const field of AUDIENCE_FIELDS) {
    if (next[field] === undefined) continue;
    const changed = next[field] !== prevAudience?.[field];
    const carried: FieldProvenance = prevProvenance?.[field] ?? 'admin-supplied';
    provenance[field] = changed ? 'admin-supplied' : carried;
  }
  return provenance;
}

/**
 * Resolve goal provenance for a version-meta edit: `admin-supplied` when the
 * goal value changed, else the carried provenance (same change-aware rule as
 * {@link audienceProvenanceForEdit}, so an unchanged inferred goal stays inferred).
 */
export function goalProvenanceForEdit(
  next: string,
  prevGoal: string | null,
  prevProvenance: FieldProvenance | null
): FieldProvenance {
  return next !== prevGoal ? 'admin-supplied' : (prevProvenance ?? 'admin-supplied');
}

/**
 * Throw a 400 when an explicit `key` is already used by another slot in the
 * version. Run this BEFORE forking a launched version so a doomed explicit-key
 * edit doesn't leave an orphan draft (the fork commits in its own transaction,
 * which a later P2002 on the write would not roll back).
 */
export async function assertKeyAvailable(
  versionId: string,
  key: string,
  exceptId?: string
): Promise<void> {
  const clash = await prisma.appQuestionSlot.findFirst({
    where: { versionId, key, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new ValidationError('Question key already in use in this version', {
      key: ['Key already in use in this version'],
    });
  }
}
