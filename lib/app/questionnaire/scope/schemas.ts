/**
 * Zod schemas for Adaptive Scope (P17): the topic bulk-save body and the settings patch.
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
  MIN_CONDITIONAL_TOPICS,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_VALUE_MAX_LENGTH,
  TOPIC_CRITERIA_MAX_LENGTH,
  TOPIC_DEPTHS,
  TOPIC_DESCRIPTION_MAX_LENGTH,
  TOPIC_KEY_MAX_LENGTH,
  TOPIC_LABEL_MAX_LENGTH,
  TOPIC_PHASES,
} from '@/lib/app/questionnaire/scope/types';

/** A stable slug: lowercase alphanumerics and underscores. Matches the authoring key recipe. */
export const topicKeySchema = z
  .string()
  .trim()
  .min(1, 'Key is required')
  .max(TOPIC_KEY_MAX_LENGTH)
  .regex(/^[a-z0-9_]+$/, 'Key may use lowercase letters, numbers and underscores only');

const keyListSchema = z.array(z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH)).max(500);

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
  dataSlotKey: z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH),
  operator: z.enum(SCOPE_RULE_OPERATORS),
  value: z.string().trim().max(SCOPE_RULE_VALUE_MAX_LENGTH).nullable().default(null),
  action: z.enum(SCOPE_RULE_ACTIONS),
  topicKey: topicKeySchema,
});

/**
 * The `adaptiveScope` settings patch.
 *
 * Every field optional so the Settings tab can PATCH one knob without resending the rest — the
 * caller merges onto the narrowed current value.
 */
export const adaptiveScopeSettingsSchema = z.object({
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
  rules: z.array(scopeRuleInputSchema).max(100).optional(),
});

export type AdaptiveScopeSettingsPatch = z.infer<typeof adaptiveScopeSettingsSchema>;

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
});

export type AcceptTopicDraftBody = z.infer<typeof acceptTopicDraftSchema>;

/** The body of an analysis run — an optional free-text steer for this run only. */
export const runRoutingAnalysisSchema = z.object({
  instructions: z.string().trim().max(2_000).optional(),
});

export type RunRoutingAnalysisBody = z.infer<typeof runRoutingAnalysisSchema>;
