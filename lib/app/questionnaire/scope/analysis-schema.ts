/**
 * The Routing Analyst's structured-output contract (P17.4).
 *
 * The analyst is a PROPOSER, not an author. It reads an uploaded instrument — including the
 * instruction pages real questionnaires carry but the extractor deliberately ignores, the
 * "Routing", "Guardrails", "How to use this" tabs — and returns the topic set and hard rules those
 * pages describe. Nothing it returns is live: the whole proposal lands in
 * `AppQuestionnaireTopicDraft` for an admin to review, exactly as a generated data-slot set does.
 *
 * **Why this contract carries `rationale` and `sourceQuote` on every item.** The admin's job here
 * is adjudication. A proposed criterion they cannot trace to the document's own words is one they
 * have to re-derive from scratch — at which point writing the topic by hand is less work, and the
 * feature has cost them time rather than saved it. The quote is what makes review cheap.
 *
 * Caps are deliberate. An instrument whose every paragraph becomes a topic is a proposal nobody
 * will read; the prompt asks for restraint and these caps stop a runaway response regardless.
 *
 * **`gaps` (Phase 2, F17.19).** Routing language the analyst recognized but could not formalize
 * into a topic or a hard rule — a vague eligibility clause, a rule that would need a data slot the
 * instrument never produced. Previously this language was silently dropped; now it is reported, so
 * the admin sees what the document said that the proposal above does not cover, rather than nothing.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import {
  MAX_CONDITIONAL_TOPICS_CEILING,
  MIN_CONDITIONAL_TOPICS,
  SCOPE_RATIONALE_MAX_LENGTH,
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_VALUE_MAX_LENGTH,
  TOPIC_CRITERIA_MAX_LENGTH,
  TOPIC_DEPTHS,
  TOPIC_KEY_MAX_LENGTH,
  TOPIC_LABEL_MAX_LENGTH,
  TOPIC_PHASES,
} from '@/lib/app/questionnaire/scope/types';

/** Hard cap on topics from one analysis run. */
export const ROUTING_ANALYSIS_MAX_TOPICS = 40;

/** Hard cap on proposed hard rules. Rules are for certainties, and certainties are few. */
export const ROUTING_ANALYSIS_MAX_RULES = 20;

/**
 * Hard cap on reported gaps. A gap is the analyst admitting it recognized routing language it could
 * not formalize — a small honesty channel, not a second proposal, so it is capped tighter than
 * topics.
 */
export const ROUTING_ANALYSIS_MAX_GAPS = 15;

/** Quoted spans are evidence, not excerpts of the whole document. */
const SOURCE_QUOTE_MAX_LENGTH = 1_000;

const proposedTopicSchema = z.object({
  /** Slug the plan, the rules and the blind-spot preference will address this topic by. */
  key: z
    .string()
    .trim()
    .min(1)
    .max(TOPIC_KEY_MAX_LENGTH)
    .regex(/^[a-z0-9_]+$/, 'Key may use lowercase letters, numbers and underscores only'),
  label: z.string().trim().min(1).max(TOPIC_LABEL_MAX_LENGTH),
  phase: z.enum(TOPIC_PHASES),
  /**
   * "Include this when…", in the DOCUMENT's words where it has them. Null is legal — an always-run
   * topic needs none — but a `conditional` topic without one is refused below, because it would
   * give the planner nothing to judge and the admin nothing to correct.
   */
  criteria: z.string().trim().max(TOPIC_CRITERIA_MAX_LENGTH).nullable().default(null),
  depth: z.enum(TOPIC_DEPTHS).default('full'),
  questionKeys: z.array(z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH)).max(500).default([]),
  dataSlotKeys: z.array(z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH)).max(500).default([]),
  /** Why the analyst judged this a topic, and this phase. The admin's main review signal. */
  rationale: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
  /** The span of the source document that says so. Absent when nothing in it did. */
  sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
});

export type ProposedTopicPayload = z.infer<typeof proposedTopicSchema>;

const proposedRuleSchema = z.object({
  dataSlotKey: z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH),
  operator: z.enum(SCOPE_RULE_OPERATORS),
  value: z.string().trim().max(SCOPE_RULE_VALUE_MAX_LENGTH).nullable().default(null),
  action: z.enum(SCOPE_RULE_ACTIONS),
  topicKey: z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH),
  rationale: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
  sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
});

export type ProposedRulePayload = z.infer<typeof proposedRuleSchema>;

/**
 * Routing language the analyst recognized but could not turn into a topic or a hard rule — a
 * vague eligibility clause, a reference to something the instrument never defines, a rule that
 * would need a data slot the extractor did not produce. Unlike a topic or rule, `sourceQuote` is
 * REQUIRED: a gap that cannot be traced to the document's own words is not a gap, it is the analyst
 * inventing a problem, and the point of this field is the opposite — admitting what the document
 * said that the proposal above does not cover.
 */
const proposedGapSchema = z.object({
  sourceQuote: z.string().trim().min(1).max(SOURCE_QUOTE_MAX_LENGTH),
  /** What the analyst recognized but could not formalize, and why. */
  explanation: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
});

export type ProposedGapPayload = z.infer<typeof proposedGapSchema>;

export const routingAnalysisSchema = z.object({
  topics: z
    .array(proposedTopicSchema)
    .max(ROUTING_ANALYSIS_MAX_TOPICS)
    .refine(
      (topics) => new Set(topics.map((t) => t.key)).size === topics.length,
      'Two proposed topics share a key'
    )
    .refine(
      (topics) => topics.every((t) => t.phase !== 'conditional' || (t.criteria ?? '').length > 0),
      // A conditional topic with no criteria is not a proposal — it is a topic the planner cannot
      // judge and the admin cannot correct, so it is refused at the contract rather than silently
      // landing in the review queue as work the admin has to finish themselves.
      'A conditional topic must carry the criteria for including it'
    ),
  rules: z.array(proposedRuleSchema).max(ROUTING_ANALYSIS_MAX_RULES).default([]),
  /** Routing language recognized but not formalized into a topic or rule (Phase 2, F17.19). */
  gaps: z.array(proposedGapSchema).max(ROUTING_ANALYSIS_MAX_GAPS).default([]),
  /** Only when the document states a breadth limit of its own. Omitted otherwise. */
  maxConditionalTopics: z
    .number()
    .int()
    .min(MIN_CONDITIONAL_TOPICS)
    .max(MAX_CONDITIONAL_TOPICS_CEILING)
    .optional(),
  summary: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
  /** The analyst's own claim about whether the document contained routing instructions at all. */
  fromDocument: z.boolean(),
});

export type RoutingAnalysisResult = z.infer<typeof routingAnalysisSchema>;

/** JSON-schema serialisation for a provider structured-output request. */
export const routingAnalysisJsonSchema: Record<string, unknown> = z.toJSONSchema(
  routingAnalysisSchema,
  { unrepresentable: 'any' }
);

/** Discriminated result of validating a parsed candidate against the contract. */
export type RoutingAnalysisValidation =
  { ok: true; value: RoutingAnalysisResult } | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate an already-JSON-parsed value against {@link routingAnalysisSchema}. */
export function validateRoutingAnalysis(parsed: unknown): RoutingAnalysisValidation {
  const result = routingAnalysisSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
