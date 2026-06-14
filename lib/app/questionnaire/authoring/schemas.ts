/**
 * Request-body schemas for the authoring mutation surface (F2.1 / PR2).
 *
 * One Zod schema per mutation endpoint. Enums derive from the `const` tuples in
 * `../types.ts` (single source of truth) and the audience shape is reused from the
 * ingestion contract so the admin edit path and the extractor agree on the same
 * structure. `typeConfig` is intentionally left as `unknown` here — it is
 * validated against the *effective* question type by `validateTypeConfig` in the
 * route (the type may come from the body or the stored row), which a static schema
 * can't express.
 *
 * Provenance (`goalProvenance`/`audienceProvenance`) is NOT accepted from the
 * client: when an admin edits a field, the route stamps it `admin-supplied`
 * server-side. Trusting a client-sent provenance would let the UI mislabel an
 * admin edit as `inferred`.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { APP_QUESTIONNAIRE_STATUSES, QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';

/** A non-empty entity id (cuid). Kept loose — existence is checked against the DB. */
const idSchema = z.string().min(1);

/**
 * PATCH version meta — goal and/or audience. `null` clears the field; an omitted
 * key leaves it unchanged. At least one key must be present.
 */
export const updateVersionMetaSchema = z
  .object({
    goal: z.string().min(1).nullable().optional(),
    audience: audienceShapeSchema.nullable().optional(),
  })
  .refine((b) => b.goal !== undefined || b.audience !== undefined, {
    message: 'Provide at least one of goal or audience',
  });

/** PATCH version status — the lifecycle flip (transition legality checked in the route). */
export const updateVersionStatusSchema = z.object({
  status: z.enum(APP_QUESTIONNAIRE_STATUSES),
});

/** POST a new section. `ordinal` defaults to "append" (resolved in the route) when omitted. */
export const createSectionSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  ordinal: z.number().int().nonnegative().optional(),
});

/** PATCH an existing section. At least one editable field required. */
export const updateSectionSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).nullable().optional(),
  })
  .refine((b) => b.title !== undefined || b.description !== undefined, {
    message: 'Provide at least one field to update',
  });

/** PATCH a reorder — the full new order of child ids within the parent. */
export const reorderSchema = z.object({
  order: z.array(idSchema).min(1),
});

/** POST a new question under a section. `key` is derived from `prompt` when omitted. */
/**
 * Per-question selection weight — bounded to the Structure editor's slider scale:
 * `0.1` (lightest) … `1.0` (heaviest), in `0.1` steps. The admin authoring routes are
 * the only writers of this field (ingestion persists weights on its own path), so the
 * bound matches the only control that sets it. Relative/scale-invariant in scoring, so
 * the absolute range is a UX choice, not a behavioural one.
 */
const questionWeightSchema = z.number().min(0.1).max(1);

export const createQuestionSchema = z.object({
  prompt: z.string().min(1),
  type: z.enum(QUESTION_TYPES),
  key: z.string().min(1).optional(),
  guidelines: z.string().min(1).nullable().optional(),
  rationale: z.string().min(1).nullable().optional(),
  required: z.boolean().optional(),
  weight: questionWeightSchema.optional(),
  /** Validated against `type` by `validateTypeConfig` in the route. */
  typeConfig: z.unknown().optional(),
  ordinal: z.number().int().nonnegative().optional(),
});

/**
 * PATCH a question — every field optional. `sectionId` + `ordinal` move it (across
 * or within sections); `key` is the admin's explicit key (collisions surface as
 * 400). At least one field required.
 */
export const updateQuestionSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    key: z.string().min(1).optional(),
    guidelines: z.string().min(1).nullable().optional(),
    rationale: z.string().min(1).nullable().optional(),
    required: z.boolean().optional(),
    weight: questionWeightSchema.optional(),
    typeConfig: z.unknown().optional(),
    sectionId: idSchema.optional(),
    ordinal: z.number().int().nonnegative().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdateVersionMetaInput = z.infer<typeof updateVersionMetaSchema>;
export type UpdateVersionStatusInput = z.infer<typeof updateVersionStatusSchema>;
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
export type ReorderInput = z.infer<typeof reorderSchema>;
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;
