/**
 * Conditional Topics evaluation contract and in-memory shapes (F17.21).
 *
 * A second "panel of judges" — sibling to the design-evaluation panel (`evaluation/**`, F5.1–F5.3)
 * — but scoring the AUTHORED CONDITIONAL-TOPICS CONFIG (topics, hard rules, planner instructions,
 * budget) rather than the question structure. Conditional Topics has no single stated objective; the
 * implicit one, read off `.context/app/questionnaire/conditional-topics.md`, is what these judges score
 * toward: minimise respondent burden (skip topics that genuinely do not apply) while never silently
 * dropping a topic that does (hard rules always win, "when in doubt, ask", exclude beats include).
 *
 * **Structural only, v1.** The judges read the authored config exactly as an admin would on the
 * Topics tab — they do NOT read live session data or the `analytics/routing.ts` behavioural
 * findings (`criteria_never_fires`, `respondents_keep_adding`, …). A later phase could layer that
 * in; this module's DTO has no field for it, so that boundary cannot be crossed by accident.
 *
 * **A new sibling module, not an extension of `evaluation/**`.** `EVALUATION_DIMENSIONS` is a closed
 * 7-value tuple compile-time-locked to `ProposedEdit`'s question/section/goal/audience vocabulary —
 * neither generalises to topics/rules/settings without forcing a structurally unrelated union onto a
 * shipped F5 surface. What IS reused (never re-declared) is genuinely generic across both panels:
 * {@link FindingSeverity} and {@link FindingReviewStatus} from `evaluation/types` (see the barrel).
 *
 * Pure, DB-free: no Prisma, no Next.js. The dispatch capability and the route-local loader
 * (`_lib/scope-evaluation-structure.ts`) supply the I/O.
 */

import type {
  TopicDepth,
  TopicPhase,
  ScopeRuleAction,
  ScopeRuleOperator,
} from '@/lib/app/questionnaire/scope/types';
import type { FindingSeverity } from '@/lib/app/questionnaire/evaluation/types';

/**
 * The four scope-evaluation dimensions, as a `const` tuple — the single source of truth. Each maps
 * to a mechanical check `scope/validate.ts` (`validateConditionalTopics`) already runs; the judges are
 * told what that checker already caught (via {@link ScopeStructureInput.knownIssues}) and prompted
 * to leave it alone, focusing on the judgement calls no deterministic rule can make.
 */
export const SCOPE_EVALUATION_DIMENSIONS = [
  'criteria_quality',
  'rule_integrity',
  'budget_realism',
  'coverage_and_burden',
] as const;
export type ScopeEvaluationDimension = (typeof SCOPE_EVALUATION_DIMENSIONS)[number];

/**
 * The op vocabulary for a {@link ScopeProposedEdit} — mirrors the `PROPOSED_EDIT_OPS` discipline in
 * `evaluation/types.ts`: a `const`-tuple single source of truth the apply engine (F17.21 phase C)
 * switches on and the judge prompt names.
 */
export const SCOPE_PROPOSED_EDIT_OPS = [
  'edit_topic_criteria',
  'edit_topic_depth',
  'add_rule',
  'edit_rule',
  'delete_rule',
  'adjust_budget',
  'edit_planner_instructions',
  'add_fallback_topic',
] as const;
export type ScopeProposedEditOp = (typeof SCOPE_PROPOSED_EDIT_OPS)[number];

/**
 * A **structured, machine-applicable** edit a scope judge may attach to a finding, alongside the
 * prose `proposedChange` — same posture as design-evaluation's `ProposedEdit`: an accelerator, never
 * a trust boundary, re-validated at apply time (F17.21 phase C) exactly like a hand-authored edit.
 *
 * Ops address their target the way `targetKey` does — `topic:<key>` / `rule:<id>` / the literal
 * `settings` — and never repeat the key inside the op itself, the same convention `replace_prompt`
 * uses. `add_rule` targets `settings` (there is no existing rule id to be a target of) rather than
 * inventing a synthetic id, the same posture `add_question` takes toward `goal`.
 */
export type ScopeProposedEdit =
  /** Rewrite a conditional topic's "include this when…" criteria. Target: `topic:<key>`. (criteria_quality) */
  | { op: 'edit_topic_criteria'; criteria: string }
  /** Change a topic's depth. Target: `topic:<key>`. (coverage_and_burden) */
  | { op: 'edit_topic_depth'; depth: TopicDepth }
  /** Add a new hard rule. Target: `settings`. (rule_integrity) */
  | {
      op: 'add_rule';
      dataSlotKey: string;
      operator: ScopeRuleOperator;
      value: string | null;
      action: ScopeRuleAction;
      topicKey: string;
    }
  /** Replace an existing rule's fields in place. Target: `rule:<id>`. (rule_integrity) */
  | {
      op: 'edit_rule';
      dataSlotKey: string;
      operator: ScopeRuleOperator;
      value: string | null;
      action: ScopeRuleAction;
      topicKey: string;
    }
  /** Remove a rule. Target: `rule:<id>`. (rule_integrity) */
  | { op: 'delete_rule' }
  /** Adjust one or more budget knobs. At least one field present. Target: `settings`. (budget_realism) */
  | {
      op: 'adjust_budget';
      sessionBudgetSeconds?: number;
      maxOpeningProbes?: number;
      maxConditionalTopics?: number;
    }
  /** Replace the planner-instructions blob. Target: `settings`. (any dimension) */
  | { op: 'edit_planner_instructions'; plannerInstructions: string }
  /** Add a topic key to the fallback set. Target: `settings`. (coverage_and_burden) */
  | { op: 'add_fallback_topic'; topicKey: string };

/**
 * One actionable suggestion from a scope judge. `targetKey` addresses what the finding is about: a
 * topic by its stable `key` (`topic:<key>`), a rule by its stable `id` (`rule:<id>`), or the literal
 * `settings` for a finding about budget/cap/planner-instructions that is not about one topic or
 * rule. A free string, not validated against the live config here — the pure core has no graph; the
 * apply engine reconciles it at apply time, fail-cleanly.
 */
export interface ScopeJudgeFinding {
  /** What this finding is about — `topic:<key>`, `rule:<id>`, or `settings`. */
  targetKey: string;
  severity: FindingSeverity;
  /** The concrete edit the judge proposes. */
  proposedChange: string;
  /** Why the change is warranted, in one or two sentences. */
  rationale: string;
  /** The offending text quoted from the config, when the finding points at one. */
  sourceQuote?: string;
  /** Optional structured edit (F17.21 phase C) the review queue can apply in one click. */
  proposedEdit?: ScopeProposedEdit;
}

/**
 * One judge's verdict for one dimension. `score` is continuous in [0, 1] (1 = the dimension is in
 * great shape). `dimension` is stamped by the caller, not the LLM — a judge can never mislabel its
 * own verdict, same as `JudgeVerdict`.
 */
export interface ScopeJudgeVerdict {
  dimension: ScopeEvaluationDimension;
  score: number;
  findings: ScopeJudgeFinding[];
}

/** One topic, flattened for the judge prompt. */
export interface ScopeStructureTopic {
  key: string;
  label: string;
  phase: TopicPhase;
  /** Null on a topic with no authored criteria — the checker already flags this; judges see it too. */
  criteria: string | null;
  depth: TopicDepth;
  /** Resolved member labels (question prompts / data-slot names), not bare keys, so a judge can read what the topic actually asks. */
  members: { key: string; label: string }[];
}

/** One hard rule, rendered as a plain sentence (via `scope/rule-format.ts`) plus its raw fields. */
export interface ScopeStructureRule {
  id: string;
  sentence: string;
  dataSlotKey: string;
  topicKey: string;
  operator: ScopeRuleOperator;
  action: ScopeRuleAction;
}

/** The curated settings slice the judges read — the knobs a finding can plausibly be about. */
export interface ScopeStructureSettings {
  maxConditionalTopics: number;
  includeCheckTopic: boolean;
  fallbackTopicKeys: string[];
  minConfidence: number;
  plannerInstructions: string;
  sessionBudgetSeconds: number;
  limitOpeningProbes: boolean;
  maxOpeningProbes: number;
}

/**
 * The pre-computed time arithmetic (`scope/budget.ts`), handed to the `budget_realism` judge so it
 * never re-derives its own numbers — "one implementation, so the number an author reads and the
 * number the planner works to cannot disagree" applies here too.
 */
export interface ScopeStructureCosts {
  budgetSeconds: number;
  alwaysSeconds: number;
  routedAllowanceSeconds: number;
  perTopic: { key: string; fullSeconds: number; lightSeconds: number }[];
}

/** One finding `validateConditionalTopics` already raised — context, not a target for the judges to repeat. */
export interface ScopeStructureIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  topicKey?: string;
}

/**
 * The pure DTO the route assembles from a version's persisted scope config and hands to the prompt
 * builder. Keeps `lib/app/**` Prisma-free: all the `findFirst`/select lives in the route-local
 * loader (`_lib/scope-evaluation-structure.ts`), the same seam split as `buildEvaluationStructure`.
 */
export interface ScopeStructureInput {
  topics: ScopeStructureTopic[];
  rules: ScopeStructureRule[];
  settings: ScopeStructureSettings;
  costs: ScopeStructureCosts;
  /** `validateConditionalTopics`'s output — "already caught, don't repeat this" context for the judges. */
  knownIssues: ScopeStructureIssue[];
}
