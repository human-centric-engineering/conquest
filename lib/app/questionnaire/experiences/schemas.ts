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
  EXPERIENCE_SEAM_MARKERS,
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
import {
  BREAKOUT_BRIEFING_MAX_LENGTH,
  BREAKOUT_MAX_DURATION_SECONDS,
  BREAKOUT_MIN_DURATION_SECONDS,
  BREAKOUT_SYNTHESIS_FOCUS_MAX_LENGTH,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import {
  DATA_SLOT_KEY_MAX_LENGTH,
  ROUTING_RULE_OPERATORS,
  ROUTING_RULE_VALUE_MAX_LENGTH,
  VALUELESS_OPERATORS,
} from '@/lib/app/questionnaire/experiences/routing/types';

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
    stitchedSeamMarker: z.enum(EXPERIENCE_SEAM_MARKERS),
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
  /** Facilitated meetings (P15.5): the breakout's default length. Null means untimed. */
  durationSeconds: z
    .number()
    .int()
    .min(BREAKOUT_MIN_DURATION_SECONDS)
    .max(BREAKOUT_MAX_DURATION_SECONDS)
    .nullish(),
  /** What the facilitator says to the room before sending them off. */
  briefing: z.string().max(BREAKOUT_BRIEFING_MAX_LENGTH).nullish(),
  /** What this breakout's synthesis should look for. */
  synthesisFocus: z.string().max(BREAKOUT_SYNTHESIS_FOCUS_MAX_LENGTH).nullish(),
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
    /** Facilitated meetings (P15.5): the breakout's default length. Null means untimed. */
    durationSeconds: z
      .number()
      .int()
      .min(BREAKOUT_MIN_DURATION_SECONDS)
      .max(BREAKOUT_MAX_DURATION_SECONDS)
      .nullish(),
    /** What the facilitator says to the room before sending them off. */
    briefing: z.string().max(BREAKOUT_BRIEFING_MAX_LENGTH).nullish(),
    /** What this breakout's synthesis should look for. */
    synthesisFocus: z.string().max(BREAKOUT_SYNTHESIS_FOCUS_MAX_LENGTH).nullish(),
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

/* -------------------------------------------------------------------------- */
/* Routing rules (P15.2)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create a routing rule.
 *
 * `value` is required for every operator except the valueless ones — a `contains` rule with no
 * operand would match nothing (the evaluator rejects an empty needle rather than matching
 * everything), so accepting it silently would create a rule that never fires.
 */
export const createRoutingRuleSchema = z
  .object({
    dataSlotKey: z.string().min(1).max(DATA_SLOT_KEY_MAX_LENGTH),
    operator: z.enum(ROUTING_RULE_OPERATORS),
    value: z.string().max(ROUTING_RULE_VALUE_MAX_LENGTH).nullish(),
    targetStepKey: z.string().min(1).max(EXPERIENCE_STEP_KEY_MAX_LENGTH),
  })
  .superRefine((rule, ctx) => {
    const needsValue = !VALUELESS_OPERATORS.includes(rule.operator);
    if (
      needsValue &&
      (rule.value === null || rule.value === undefined || rule.value.trim() === '')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `The "${rule.operator}" comparison needs a value to compare against`,
      });
    }
    if ((rule.operator === 'gt' || rule.operator === 'lt') && rule.value != null) {
      if (!Number.isFinite(Number(rule.value))) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'A greater/less-than comparison needs a number',
        });
      }
    }
  });

export type CreateRoutingRuleInput = z.infer<typeof createRoutingRuleSchema>;

/**
 * Update a routing rule — the full rule, not a patch.
 *
 * Deliberately not `.partial()`: the operator and value are interdependent (changing `exists` to
 * `gt` requires a numeric value to arrive with it), and a partial update would have to re-read the
 * row to re-validate the pair. Sending the whole rule keeps the cross-field check honest.
 */
export const updateRoutingRuleSchema = createRoutingRuleSchema;

export type UpdateRoutingRuleInput = z.infer<typeof updateRoutingRuleSchema>;

/** Reorder rules — the complete ordered id list, same contract as step reorder. */
export const reorderRoutingRulesSchema = z.object({
  ruleIds: z.array(idSchema).min(1),
});

/**
 * Dry-run the selector against a real completed session, without side effects.
 *
 * Lets an author see what their criteria and instructions actually produce before a respondent
 * meets them.
 */
export const previewRoutingSchema = z.object({
  sessionId: idSchema,
});

export type PreviewRoutingInput = z.infer<typeof previewRoutingSchema>;

/** Query filters for the experience list. */
export const listExperiencesQuerySchema = z.object({
  status: z.enum(EXPERIENCE_STATUSES).optional(),
  kind: z.enum(EXPERIENCE_KINDS).optional(),
  demoClientId: idSchema.optional(),
});

export type ListExperiencesQuery = z.infer<typeof listExperiencesQuerySchema>;
