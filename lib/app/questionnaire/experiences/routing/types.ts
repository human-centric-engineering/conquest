/**
 * Experience routing (P15.2) — pure domain types.
 *
 * The vocabulary shared by the rule evaluator, the LLM selector, the fallback, and the admin
 * routing editor. No Prisma, no Next.
 */

/**
 * How a rule compares a carry-over slot against its operand.
 *
 * Deliberately small. A richer expression language (AND/OR trees, nested groups) is what the LLM
 * selector is for — rules exist to hard-pin the handful of cases an author is certain about, and a
 * flat first-match-wins list is legible at a glance in a way a boolean tree is not.
 */
export const ROUTING_RULE_OPERATORS = ['equals', 'contains', 'gt', 'lt', 'exists'] as const;
export type RoutingRuleOperator = (typeof ROUTING_RULE_OPERATORS)[number];

/** Human labels for the operator select. */
export const ROUTING_RULE_OPERATOR_LABELS: Record<RoutingRuleOperator, string> = {
  equals: 'is exactly',
  contains: 'contains',
  gt: 'is greater than',
  lt: 'is less than',
  exists: 'has any answer',
};

/** Operators that ignore `value` — the admin form hides the operand field for these. */
export const VALUELESS_OPERATORS: readonly RoutingRuleOperator[] = ['exists'];

/** One rule, as the evaluator sees it. */
export interface RoutingRule {
  id: string;
  dataSlotKey: string;
  operator: RoutingRuleOperator;
  value: string | null;
  targetStepKey: string;
  ordinal: number;
}

/** A candidate the selector may choose between. */
export interface CandidateStep {
  stepKey: string;
  title: string;
  purpose: string | null;
  selectionCriteria: string | null;
  ordinal: number;
}

/** Field bounds for the rule editor. */
export const ROUTING_RULE_VALUE_MAX_LENGTH = 500;
export const DATA_SLOT_KEY_MAX_LENGTH = 128;
