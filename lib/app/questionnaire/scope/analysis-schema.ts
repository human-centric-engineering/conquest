/**
 * The Routing Analyst's structured-output contract (P17.4).
 *
 * The analyst is a PROPOSER, not an author. It reads an uploaded instrument — including the
 * guidance real questionnaires carry but the extractor deliberately ignores: routing and
 * eligibility notes, guardrails, "how to use this" instructions, wherever in the file they sit —
 * and returns the topic set and hard rules that guidance describes. Nothing it returns is live:
 * the whole proposal lands in
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
  MAX_TRIGGER_CUES,
  MAX_PROPOSED_PLANNER_INSTRUCTIONS,
  MAX_PROPOSED_SETTING_KEYS,
  MIN_CONDITIONAL_TOPICS,
  SCOPE_RATIONALE_MAX_LENGTH,
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_VALUE_MAX_LENGTH,
  TOPIC_CRITERIA_MAX_LENGTH,
  TOPIC_DEPTHS,
  MEMBER_KEY_MAX_LENGTH,
  TOPIC_KEY_MAX_LENGTH,
  TOPIC_LABEL_MAX_LENGTH,
  TOPIC_PHASES,
  TRIGGER_CUE_MAX_LENGTH,
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
  // References to keys minted elsewhere — bounded by MEMBER_KEY_MAX_LENGTH, never the topic bound.
  // The analyst echoes back the question keys it was given; rejecting one for length fails the whole
  // analysis on a document whose only sin is a long prose question, and no retry can fix it.
  questionKeys: z.array(z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH)).max(500).default([]),
  dataSlotKeys: z.array(z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH)).max(500).default([]),
  /** Why the analyst judged this a topic, and this phase. The admin's main review signal. */
  rationale: z.string().trim().min(1).max(SCOPE_RATIONALE_MAX_LENGTH),
  /** The span of the source document that says so. Absent when nothing in it did. */
  sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
  /**
   * What the document asked for when it asked for something the opening cannot decide — "add this
   * whenever it surfaces, at any point" (F17.31a).
   *
   * **Recorded alongside `criteria`, never instead of it.** Scope is still settled once, when the
   * opening completes, so a topic whose only routing lived here would be asked of nobody. The
   * criteria stays the closest-fit approximation the product actually runs; this says what was
   * really asked for, so the admin sees the difference on the topic itself.
   *
   * Every field is lenient by design. `cues` defaults to empty rather than requiring one, because a
   * refusal here fails the WHOLE analysis with no retry that can help — the lesson of T13 in
   * `routing-corpus/RESULTS.md`, where one over-strict bound cost an entire document its proposal.
   * An empty cue list is reported by `validateConditionalTopics`, which is the right place for it.
   *
   * The cue bounds are enforced by DROPPING, never by rejecting, for that same reason. A rejecting
   * `.max()` on the cue string is the T13 mistake wearing a different hat: an over-long cue is the
   * documented failure mode — `TRIGGER_CUE_MAX_LENGTH` exists precisely because "a long cue is a
   * sign the analyst quoted the rule instead of naming what to listen for" — and the retry message
   * never mentions cues, so the one retry is blind and the whole document's proposal is lost to a
   * field nothing reads yet. Dropping matches the read path exactly:
   * `narrowTopicTrigger` runs `asKeyList`, which slices to the same two bounds rather than failing.
   */
  trigger: z
    .object({
      condition: z.string().trim().min(1).max(TOPIC_CRITERIA_MAX_LENGTH),
      cues: z
        .array(z.string().trim().min(1))
        .default([])
        .transform((cues) =>
          cues.filter((cue) => cue.length <= TRIGGER_CUE_MAX_LENGTH).slice(0, MAX_TRIGGER_CUES)
        ),
      sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX_LENGTH).optional(),
    })
    .optional(),
});

export type ProposedTopicPayload = z.infer<typeof proposedTopicSchema>;

const proposedRuleSchema = z.object({
  dataSlotKey: z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH),
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

/**
 * Re-exported so the analyst's contract and its tests read the cap from one place.
 *
 * Membership — that every key names a topic the same proposal carries — is enforced in
 * `narrowProposedTopicSet`, not here. Deliberately: an unknown key is inert at runtime (both the
 * fallback loop and `chooseCheckTopic` skip keys they cannot resolve), so refusing the whole
 * response over one would throw away an otherwise-good proposal and pay for a retry to fix a hint.
 */
export const ROUTING_ANALYSIS_MAX_SETTING_KEYS = MAX_PROPOSED_SETTING_KEYS;

/** Re-exported for the same one-place-to-read reason as {@link ROUTING_ANALYSIS_MAX_SETTING_KEYS}. */
export const ROUTING_ANALYSIS_MAX_PLANNER_INSTRUCTIONS = MAX_PROPOSED_PLANNER_INSTRUCTIONS;

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
  /**
   * Topics to ask when the planner chose nothing at all. Only when the document names a safe
   * default — omitted otherwise, same reason as `maxConditionalTopics`.
   */
  fallbackTopicKeys: z
    .array(z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH))
    .max(ROUTING_ANALYSIS_MAX_SETTING_KEYS)
    .optional(),
  /**
   * Preferred topics for the blind-spot check, best first. Only when the document names an area
   * worth probing unprompted.
   */
  checkTopicPreference: z
    .array(z.string().trim().min(1).max(TOPIC_KEY_MAX_LENGTH))
    .max(ROUTING_ANALYSIS_MAX_SETTING_KEYS)
    .optional(),
  /**
   * Cross-cutting guidance for the planner — how to judge the plan AS A WHOLE, where the document
   * says something that is about no single topic ("prefer breadth for a first-time respondent").
   *
   * Proposable since the Extra-guidance change, on exactly the F17.23 argument that made
   * `fallbackTopicKeys` and `checkTopicPreference` proposable: documents state this routinely, and
   * with nowhere to put it the analyst reported it as an unformalizable `gap` — a proposal admitting
   * defeat about a setting the platform had implemented all along. The earlier "deliberately not
   * proposable" reasoning (an analyst writing its own steering) does not hold: this steers the
   * PLANNER, a different agent at a different point in the session, not the analyst.
   *
   * Omitted when the document says nothing, the same discipline `maxConditionalTopics` follows — a
   * default here would put the analyst's guess where the author's silence was.
   *
   * **Truncated, never rejected** — the `trigger.cues` reasoning exactly. A rejecting `.max()` here
   * would fail the WHOLE analysis over one advisory field, and the single retry is blind to it
   * (`buildRoutingAnalysisRetryMessage` names topics, rules, gaps, summary and `fromDocument` — not
   * this), so an analyst that overran would lose the document its entire proposal twice. Slicing
   * matches `narrowProposedTopicSet`, which trims to the same bound rather than dropping the field.
   *
   * **No `.min(1)` — a defined-but-empty string must never THROW, only map to `undefined`.** An
   * earlier version had `.string().trim().min(1)....optional()`, and `.optional()` only tolerates
   * the KEY being absent; it does nothing for a key present with an invalid value. A model told to
   * omit this field routinely emits `"plannerInstructions": ""` instead of actually dropping the
   * key, and that failed `.min(1)` — which was not "rejected" the way an over-long string is
   * truncated, it was `routingAnalysisSchema.safeParse()` returning `ok: false` for the WHOLE
   * response: every topic, every rule, every gap, gone. Exactly the failure this doc comment says
   * the field must never cause. The transform below has no validator that can fail on a defined
   * value — it only ever maps a string to a (possibly shorter, possibly `undefined`) string — so
   * `.optional()` stays the OUTERMOST call, same as every other optional field in this schema:
   * moving it earlier makes Zod infer the object KEY as required-with-an-`undefined`-value instead
   * of an omittable key, which breaks every literal that constructs a result without this field.
   */
  plannerInstructions: z
    .string()
    .trim()
    .transform((text) =>
      text.length > 0 ? text.slice(0, ROUTING_ANALYSIS_MAX_PLANNER_INSTRUCTIONS) : undefined
    )
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
