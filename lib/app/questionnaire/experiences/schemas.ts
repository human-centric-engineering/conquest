/**
 * Experiences — request validation schemas.
 *
 * Every Experience route validates its body through one of these before touching Prisma (the
 * boundary rule: no `as` on external data, ever). Enums derive from the `const` tuples in
 * `experiences/types.ts` so the vocabulary has exactly one definition.
 *
 * Update schemas are all-optional with an at-least-one-key refinement, matching
 * `updateConfigSchema` (`lib/app/questionnaire/authoring/config-schema.ts`): a PATCH with an empty
 * body is a caller bug worth surfacing, not a no-op worth silently accepting.
 */

import { z } from 'zod';

import { ACCESS_MODES } from '@/lib/app/questionnaire/types';
import {
  EXPERIENCE_CONTINUITY_MODES,
  EXPERIENCE_COST_BUDGET_MAX_USD,
  EXPERIENCE_DESCRIPTION_MAX_LENGTH,
  EXPERIENCE_KINDS,
  EXPERIENCE_ROUTING_FALLBACKS,
  EXPERIENCE_ROUTING_INSTRUCTIONS_MAX_LENGTH,
  EXPERIENCE_STATUSES,
  EXPERIENCE_STEP_KEY_MAX_LENGTH,
  EXPERIENCE_STEP_KINDS,
  EXPERIENCE_STEP_PURPOSE_MAX_LENGTH,
  EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH,
  EXPERIENCE_STEP_TITLE_MAX_LENGTH,
  EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH,
  EXPERIENCE_TITLE_MAX_LENGTH,
  INSIGHT_MIN_SUPPORT_CEILING,
  INSIGHT_MIN_SUPPORT_FLOOR,
  MIN_ROUTING_CONFIDENCE_CEILING,
  MIN_ROUTING_CONFIDENCE_FLOOR,
  SYNTHESIS_EVERY_N_MAX,
  SYNTHESIS_EVERY_N_MIN,
} from '@/lib/app/questionnaire/experiences/types';

/** A cuid-ish id. Loose on purpose — the FK/lookup is the real check, this only rejects junk. */
const idSchema = z.string().min(1).max(64);

/**
 * Step key: lowercase kebab. Enforced (rather than silently slugified) on explicit input so an
 * author who types a key gets told when it is invalid instead of watching it change underneath
 * them. Omitting the key entirely derives one from the title — that path slugifies.
 */
const stepKeySchema = z
  .string()
  .min(1)
  .max(EXPERIENCE_STEP_KEY_MAX_LENGTH)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens (e.g. "deep-dive-pricing")'
  );

/** Partial settings — every key optional, so a PATCH can set one without echoing the rest. */
export const experienceSettingsPatchSchema = z
  .object({
    summariseCarryOver: z.boolean(),
    carryProfile: z.boolean(),
    showRoutingRationale: z.boolean(),
    synthesisEveryNCompletions: z
      .number()
      .int()
      .min(SYNTHESIS_EVERY_N_MIN)
      .max(SYNTHESIS_EVERY_N_MAX),
    insightMinSupport: z
      .number()
      .int()
      .min(INSIGHT_MIN_SUPPORT_FLOOR)
      .max(INSIGHT_MIN_SUPPORT_CEILING),
    surfaceInsightsToRespondents: z.boolean(),
    synthesisInstructions: z.string().max(EXPERIENCE_SYNTHESIS_INSTRUCTIONS_MAX_LENGTH),
  })
  .partial();

export type ExperienceSettingsPatch = z.infer<typeof experienceSettingsPatchSchema>;

/**
 * Create an experience. Only `demoClientId`, `title` and `kind` are required — everything else has
 * a schema default, so the create form can be short and the Settings tab carries the rest.
 */
export const createExperienceSchema = z.object({
  demoClientId: idSchema,
  title: z.string().min(1).max(EXPERIENCE_TITLE_MAX_LENGTH),
  description: z.string().max(EXPERIENCE_DESCRIPTION_MAX_LENGTH).optional(),
  kind: z.enum(EXPERIENCE_KINDS),
  continuityMode: z.enum(EXPERIENCE_CONTINUITY_MODES).optional(),
  accessMode: z.enum(ACCESS_MODES).optional(),
  cohortId: idSchema.nullish(),
});

export type CreateExperienceInput = z.infer<typeof createExperienceSchema>;

/**
 * Update an experience. All keys optional; at least one required.
 *
 * `status` is accepted here rather than on a dedicated endpoint because an Experience has no
 * launch-readiness gate of its own — its steps' questionnaires carry theirs. Nullable fields use
 * `.nullish()` so a caller can explicitly clear them (`null`) as distinct from leaving them alone
 * (absent), which a plain `.optional()` could not express.
 */
export const updateExperienceSchema = z
  .object({
    title: z.string().min(1).max(EXPERIENCE_TITLE_MAX_LENGTH),
    description: z.string().max(EXPERIENCE_DESCRIPTION_MAX_LENGTH).nullish(),
    status: z.enum(EXPERIENCE_STATUSES),
    continuityMode: z.enum(EXPERIENCE_CONTINUITY_MODES),
    routingFallback: z.enum(EXPERIENCE_ROUTING_FALLBACKS),
    minRoutingConfidence: z
      .number()
      .min(MIN_ROUTING_CONFIDENCE_FLOOR)
      .max(MIN_ROUTING_CONFIDENCE_CEILING),
    routingInstructions: z.string().max(EXPERIENCE_ROUTING_INSTRUCTIONS_MAX_LENGTH).nullish(),
    costBudgetUsd: z.number().positive().max(EXPERIENCE_COST_BUDGET_MAX_USD).nullish(),
    accessMode: z.enum(ACCESS_MODES),
    cohortId: idSchema.nullish(),
    settings: experienceSettingsPatchSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateExperienceInput = z.infer<typeof updateExperienceSchema>;

/**
 * Create a step. `key` is optional — omitted, it is derived from the title and de-duplicated
 * against the experience's existing keys.
 */
export const createExperienceStepSchema = z.object({
  kind: z.enum(EXPERIENCE_STEP_KINDS),
  title: z.string().min(1).max(EXPERIENCE_STEP_TITLE_MAX_LENGTH),
  key: stepKeySchema.optional(),
  questionnaireId: idSchema.nullish(),
  versionId: idSchema.nullish(),
  roundId: idSchema.nullish(),
  purpose: z.string().max(EXPERIENCE_STEP_PURPOSE_MAX_LENGTH).nullish(),
  selectionCriteria: z.string().max(EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH).nullish(),
});

export type CreateExperienceStepInput = z.infer<typeof createExperienceStepSchema>;

/** Update a step. All keys optional; at least one required. */
export const updateExperienceStepSchema = z
  .object({
    kind: z.enum(EXPERIENCE_STEP_KINDS),
    title: z.string().min(1).max(EXPERIENCE_STEP_TITLE_MAX_LENGTH),
    key: stepKeySchema,
    questionnaireId: idSchema.nullish(),
    versionId: idSchema.nullish(),
    roundId: idSchema.nullish(),
    purpose: z.string().max(EXPERIENCE_STEP_PURPOSE_MAX_LENGTH).nullish(),
    selectionCriteria: z.string().max(EXPERIENCE_STEP_SELECTION_CRITERIA_MAX_LENGTH).nullish(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateExperienceStepInput = z.infer<typeof updateExperienceStepSchema>;

/**
 * Reorder steps: the complete ordered list of step ids.
 *
 * Deliberately the FULL list rather than a moved-item delta — the handler can then assign ordinals
 * positionally and reject a list that does not match the experience's steps exactly, which makes a
 * stale client impossible to apply silently. A delta would let two concurrent drags interleave
 * into an order neither author chose.
 */
export const reorderExperienceStepsSchema = z.object({
  stepIds: z.array(idSchema).min(1),
});

export type ReorderExperienceStepsInput = z.infer<typeof reorderExperienceStepsSchema>;

/** Query filters for the experience list. */
export const listExperiencesQuerySchema = z.object({
  status: z.enum(EXPERIENCE_STATUSES).optional(),
  kind: z.enum(EXPERIENCE_KINDS).optional(),
  demoClientId: idSchema.optional(),
});

export type ListExperiencesQuery = z.infer<typeof listExperiencesQuerySchema>;
