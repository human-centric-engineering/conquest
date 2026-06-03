/**
 * Shared glue for the tagging mutation routes (F2.2).
 *
 * Mirrors `_lib/authoring-routes.ts` for the tag surface: the scope-and-404 tag
 * load, the unique-label conflict mapper, and the same-version assignment check
 * the replace-set `PUT …/questions/:id/tags` runs before forking. Route-local DB
 * seam (uses `prisma`) — the `lib/app/questionnaire/**` module stays Prisma-free.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/api/errors';
import { normalizeTagLabel } from '@/lib/app/questionnaire/tagging';

/** The tag fields a mutation route returns / audits. */
export const TAG_SELECT = {
  id: true,
  label: true,
  normalizedLabel: true,
  color: true,
} as const;

/**
 * A vocabulary tag scoped to its version. A `type` (not `interface`) so it stays
 * assignable to `Record<string, unknown>` for `computeChanges` in the audit log.
 */
export type ScopedTag = {
  id: string;
  label: string;
  normalizedLabel: string;
  color: string | null;
};

/**
 * Load a tag scoped to its version. Returns `null` (→ route 404) when the
 * vid/tagId pair doesn't resolve, so a tag can't leak across versions (the same
 * scoping discipline as `loadScopedVersion`).
 */
export async function loadScopedTag(versionId: string, tagId: string): Promise<ScopedTag | null> {
  return prisma.appQuestionTag.findFirst({
    where: { id: tagId, versionId },
    select: TAG_SELECT,
  });
}

/**
 * Throw a 400 when `label` (normalised) is already used by another tag in the
 * version. Run this BEFORE forking a launched version so a doomed create/rename
 * doesn't leave an orphan draft — the fork commits in its own transaction, which
 * a later P2002 on the write would not roll back. Mirrors `assertKeyAvailable`.
 * `asTagConflict` stays as the race backstop on the write itself.
 */
export async function assertTagLabelAvailable(
  versionId: string,
  label: string,
  exceptId?: string
): Promise<void> {
  const normalizedLabel = normalizeTagLabel(label);
  const clash = await prisma.appQuestionTag.findFirst({
    where: { versionId, normalizedLabel, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new ValidationError('A tag with that label already exists in this version', {
      label: ['Label already in use in this version'],
    });
  }
}

/**
 * Map a Prisma unique-constraint violation on `@@unique([versionId,
 * normalizedLabel])` to a field-keyed 400. Re-throws anything else unchanged.
 * Call from a create/update catch (the normalised label is the dedup key).
 */
export function asTagConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ValidationError('A tag with that label already exists in this version', {
      label: ['Label already in use in this version'],
    });
  }
  throw err;
}

/** A version-validated tag, carrying the fields the assignment response returns. */
export type AssignableTag = {
  id: string;
  label: string;
  color: string | null;
  normalizedLabel: string;
};

/**
 * Validate that every requested tag id belongs to `versionId`, returning the
 * de-duplicated, version-checked rows. Throws a 400 naming the offending ids when
 * any is unknown or belongs to another version — this is the application-layer
 * check the denormalised `AppQuestionSlot.versionId` exists for. An empty input is
 * valid (clears all assignments). Run BEFORE forking a launched version so a doomed
 * cross-version assignment doesn't leave an orphan draft. Returns the full rows (not
 * just ids) so the caller builds the response without a second readback query.
 */
export async function resolveAssignableTags(
  versionId: string,
  tagIds: readonly string[]
): Promise<AssignableTag[]> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return [];

  const found = await prisma.appQuestionTag.findMany({
    where: { id: { in: unique }, versionId },
    select: { id: true, label: true, color: true, normalizedLabel: true },
  });
  if (found.length !== unique.length) {
    const known = new Set(found.map((t) => t.id));
    const missing = unique.filter((id) => !known.has(id));
    throw new ValidationError('One or more tags are not in this version', {
      tagIds: missing.map((id) => `Unknown or cross-version tag: ${id}`),
    });
  }
  return found;
}
