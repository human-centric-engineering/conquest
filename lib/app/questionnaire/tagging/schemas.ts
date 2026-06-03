/**
 * Request-body schemas for the tagging mutation surface (F2.2).
 *
 * One Zod schema per mutation endpoint, mirroring `authoring/schemas.ts`. The
 * `color` enum derives from the `TAG_COLORS` tuple in `../types.ts` (single source
 * of truth). `normalizedLabel` is NOT accepted from the client — the route derives
 * it from `label` via `normalizeTagLabel` so the dedup key can't be spoofed.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { TAG_COLORS } from '@/lib/app/questionnaire/types';

/** A non-empty entity id (cuid). Kept loose — existence is checked against the DB. */
const idSchema = z.string().min(1);

/** Max tag label length — generous for human phrases, bounded to stay chip-sized. */
const MAX_LABEL_LENGTH = 60;

const labelSchema = z.string().trim().min(1).max(MAX_LABEL_LENGTH);

/** POST a new vocabulary tag. `color` optional; when present, from the allowlist. */
export const createTagSchema = z.object({
  label: labelSchema,
  color: z.enum(TAG_COLORS).nullable().optional(),
});

/**
 * PATCH a tag — rename and/or recolour. `color: null` clears the swatch; an omitted
 * key leaves it unchanged. At least one editable field required.
 */
export const updateTagSchema = z
  .object({
    label: labelSchema.optional(),
    color: z.enum(TAG_COLORS).nullable().optional(),
  })
  .refine((b) => b.label !== undefined || b.color !== undefined, {
    message: 'Provide at least one field to update',
  });

/**
 * PUT a question's tag set — replace semantics. The full set of tag ids the
 * question should carry afterwards (empty array clears all). The route validates
 * every id belongs to the question's version (cross-version → 400) and dedupes.
 */
export const setQuestionTagsSchema = z.object({
  tagIds: z.array(idSchema),
});

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type SetQuestionTagsInput = z.infer<typeof setQuestionTagsSchema>;
