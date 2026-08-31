/**
 * Zod schemas for Conditional Topics (P17): the topic bulk-save body and the settings patch.
 *
 * Dependency-light (only `zod` plus the pure vocabulary) so routes and the eventual analyst
 * capability import without pulling server deps.
 *
 * Validation here is about SHAPE. Coherence — "a conditional topic with no criteria", "a rule
 * pointing at a topic that does not exist" — is deliberately NOT enforced as a hard error, because
 * an admin mid-edit routinely has an incoherent draft and refusing to save it would make the
 * surface unusable. Those are surfaced as launch-time warnings instead (`scope/validate.ts`).
 */

import { z } from 'zod';

import {
  MAX_CONDITIONAL_TOPICS_CEILING,
  MAX_OPENING_PROBES_CEILING,
  MAX_SECONDS_PER_ITEM,
  MAX_SESSION_BUDGET_SECONDS,
  MAX_TRIGGER_CUES,
  MIN_CONDITIONAL_TOPICS,
  MIN_OPENING_PROBES,
  MIN_SECONDS_PER_ITEM,
  MIN_SESSION_BUDGET_SECONDS,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_VALUE_MAX_LENGTH,
  TOPIC_CRITERIA_MAX_LENGTH,
  TOPIC_DEPTHS,
  TOPIC_DESCRIPTION_MAX_LENGTH,
  MEMBER_KEY_MAX_LENGTH,
  TOPIC_KEY_MAX_LENGTH,
  TOPIC_LABEL_MAX_LENGTH,
  TOPIC_PHASES,
  TRIGGER_CUE_MAX_LENGTH,
} from '@/lib/app/questionnaire/scope/types';

/** A stable slug: lowercase alphanumerics and underscores. Matches the authoring key recipe. */
export const topicKeySchema = z
  .string()
  .trim()
  .min(1, 'Key is required')
  .max(TOPIC_KEY_MAX_LENGTH)
  .regex(/^[a-z0-9_]+$/, 'Key may use lowercase letters, numbers and underscores only');

/**
 * Question / data-slot key references. MEMBER_KEY_MAX_LENGTH, not the topic bound — see that
 * constant: these keys are minted by the extractor and by import, and neither bounds them at 64.
 */
const keyListSchema = z.array(z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH)).max(500);

/**
 * What the instrument says to watch for mid-conversation (F17.31a) — see {@link TopicTrigger}.
 *
 * On the INPUT schema as well as the analyst's, so a trigger survives the round trip through the
 * Topics tab. The bulk save replaces the whole set from what the client sends back, so a field the
 * admin surface cannot carry is a field an ordinary save silently deletes.
 */
export const topicTriggerSchema = z.object({
  condition: z.string().trim().min(1).max(TOPIC_CRITERIA_MAX_LENGTH),
  cues: z
    .array(z.string().trim().min(1).max(TRIGGER_CUE_MAX_LENGTH))
    .max(MAX_TRIGGER_CUES)
    .default([]),
  sourceQuote: z.string().trim().max(TOPIC_CRITERIA_MAX_LENGTH).optional(),
});

/** One topic as the admin surface submits it. */
export const topicInputSchema = z.object({
  key: topicKeySchema,
  label: z.string().trim().min(1, 'Name is required').max(TOPIC_LABEL_MAX_LENGTH),
  description: z.string().trim().max(TOPIC_DESCRIPTION_MAX_LENGTH).nullable().default(null),
  phase: z.enum(TOPIC_PHASES),
  criteria: z.string().trim().max(TOPIC_CRITERIA_MAX_LENGTH).nullable().default(null),
  depth: z.enum(TOPIC_DEPTHS).default('full'),
  questionKeys: keyListSchema.default([]),
  dataSlotKeys: keyListSchema.default([]),
  trigger: topicTriggerSchema.nullable().default(null),
});

export type TopicInput = z.infer<typeof topicInputSchema>;

/**
 * The bulk save. Replaces the version's whole topic set — the same "the admin reviewed the set,
 * store the set" contract as `saveDataSlotsSchema`, which keeps ordering and deletion trivial and
 * avoids a per-row PATCH surface nobody asked for.
 */
export const saveTopicsSchema = z.object({
  topics: z
    .array(topicInputSchema)
    .max(200)
    .refine(
      (topics) => new Set(topics.map((t) => t.key)).size === topics.length,
      'Two topics share a key'
    ),
});

/** One hard rule as the admin surface submits it. */
export const scopeRuleInputSchema = z.object({
  id: z.string().trim().max(64).optional(),
  dataSlotKey: z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH),
  operator: z.enum(SCOPE_RULE_OPERATORS),
  value: z.string().trim().max(SCOPE_RULE_VALUE_MAX_LENGTH).nullable().default(null),
  action: z.enum(SCOPE_RULE_ACTIONS),
  topicKey: topicKeySchema,
});

/**
 * The `conditionalTopics` settings patch.
 *
 * Every field optional so the Settings tab can PATCH one knob without resending the rest — the
 * caller merges onto the narrowed current value.
 */
export const conditionalTopicsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxConditionalTopics: z
    .number()
    .int()
    .min(MIN_CONDITIONAL_TOPICS)
    .max(MAX_CONDITIONAL_TOPICS_CEILING)
    .optional(),
  includeCheckTopic: z.boolean().optional(),
  checkTopicPreference: z.array(topicKeySchema).max(20).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  fallbackTopicKeys: z.array(topicKeySchema).max(20).optional(),
  announce: z.boolean().optional(),
  allowRespondentAmendment: z.boolean().optional(),
  plannerInstructions: z.string().trim().max(PLANNER_INSTRUCTIONS_MAX_LENGTH).optional(),
  // C7 — the time budget. `0` is explicitly allowed alongside the legal range because 0 is how an
  // author turns the budget OFF; a bare `.min(MIN_SESSION_BUDGET_SECONDS)` would make "no budget"
  // unexpressible through the API.
  sessionBudgetSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_SESSION_BUDGET_SECONDS)
    .refine((v) => v === 0 || v >= MIN_SESSION_BUDGET_SECONDS, {
      message: `A budget must be 0 (no budget) or at least ${MIN_SESSION_BUDGET_SECONDS} seconds`,
    })
    .optional(),
  secondsPerQuestionType: z
    .record(z.string(), z.number().int().min(MIN_SECONDS_PER_ITEM).max(MAX_SECONDS_PER_ITEM))
    .optional(),
  secondsPerDataSlot: z
    .number()
    .int()
    .min(MIN_SECONDS_PER_ITEM)
    .max(MAX_SECONDS_PER_ITEM)
    .optional(),
  // G03 — the opening's shared follow-up allowance. A boolean switch beside the number because 0
  // is a real setting here ("never probe"), so it cannot also mean "no limit".
  limitOpeningProbes: z.boolean().optional(),
  maxOpeningProbes: z
    .number()
    .int()
    .min(MIN_OPENING_PROBES)
    .max(MAX_OPENING_PROBES_CEILING)
    .optional(),
  rules: z.array(scopeRuleInputSchema).max(100).optional(),
});

export type ConditionalTopicsSettingsPatch = z.infer<typeof conditionalTopicsSettingsSchema>;

/* -------------------------------------------------------------------------- */
/* The Routing Analyst's draft (P17.4)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The body of an accept (`POST …/topics/draft`) — the REVIEWED proposal, not the raw one.
 *
 * The admin edits the proposal before accepting it, so the client sends what it is actually
 * accepting rather than a bare "yes". Re-using {@link topicInputSchema} is what makes an accepted
 * proposal indistinguishable from a hand-authored save at the contract level: there is exactly one
 * definition of a valid topic, and the analyst gets no relaxed variant of it.
 */
export const acceptTopicDraftSchema = z.object({
  topics: z
    .array(topicInputSchema)
    .max(200)
    .refine(
      (topics) => new Set(topics.map((t) => t.key)).size === topics.length,
      'Two topics share a key'
    ),
  /** Omitted leaves the version's existing rules alone; present REPLACES them. */
  rules: z.array(scopeRuleInputSchema).max(100).optional(),
  /** Only sent when the analyst read a breadth limit out of the document and the admin kept it. */
  maxConditionalTopics: z
    .number()
    .int()
    .min(MIN_CONDITIONAL_TOPICS)
    .max(MAX_CONDITIONAL_TOPICS_CEILING)
    .optional(),
  /**
   * Only sent when the analyst read one out of the document and the admin kept it. Omitted leaves
   * the version's existing value alone; present REPLACES it — same contract as `rules`.
   *
   * Capped at 20 to match the settings PATCH above rather than the analyst's own proposal cap —
   * both paths write the same field, so a value acceptable through one must be acceptable through
   * the other.
   */
  fallbackTopicKeys: z.array(topicKeySchema).max(20).optional(),
  /** Same contract as `fallbackTopicKeys` above. */
  checkTopicPreference: z.array(topicKeySchema).max(20).optional(),
  /**
   * Cross-cutting planner guidance the analyst read out of the document and the admin kept. Same
   * omitted-leaves-alone / present-replaces contract as `rules`.
   *
   * Capped at the FIELD's length rather than the analyst's tighter proposal cap, for the same
   * reason `fallbackTopicKeys` is capped at 20 here and 5 there: both paths write the same field,
   * so anything acceptable through the settings PATCH must be acceptable through this one — the
   * admin may have edited the proposal before accepting it.
   */
  plannerInstructions: z.string().trim().max(PLANNER_INSTRUCTIONS_MAX_LENGTH).optional(),
  /**
   * Turn conditional topics ON as part of this accept (F17.22 Phase 4). Sent only when the admin ticks
   * the offer in the accept dialog, which is itself only shown when the proposal contains a
   * conditional topic.
   *
   * `literal(true)`, not `boolean`, and deliberately named for the ACT rather than the state: this
   * route can turn the feature on and can never turn it off. Omitting it leaves `enabled` exactly
   * where it was, which is what every accept did before this field existed. The invariant holds —
   * `enabled` still moves only on an explicit admin act; this is that act, one click earlier.
   */
  enable: z.literal(true).optional(),
});

export type AcceptTopicDraftBody = z.infer<typeof acceptTopicDraftSchema>;

/** The body of an analysis run — an optional free-text steer for this run only. */
export const runRoutingAnalysisSchema = z.object({
  instructions: z.string().trim().max(2_000).optional(),
});

export type RunRoutingAnalysisBody = z.infer<typeof runRoutingAnalysisSchema>;
