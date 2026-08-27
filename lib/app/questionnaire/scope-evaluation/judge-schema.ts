/**
 * The scope judge's structured-output contract (F17.21).
 *
 * Every judge — whichever dimension — returns the same shape: a continuous `score` in [0, 1] and a
 * list of actionable `findings`. Mirrors `evaluation/judge-schema.ts` exactly. `dimension` is NOT
 * part of this contract: the caller stamps which dimension the verdict belongs to.
 *
 * The `proposedEdit` fields reuse the SAME Zod fragments the Topics tab's own authoring routes
 * validate against (`topicKeySchema`, `scopeRuleInputSchema`'s field-level bounds, the `scope/types`
 * numeric ceilings) — one definition of "a valid rule" / "a valid budget", not a second one that
 * could silently accept something the authoring surface would reject.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { FINDING_SEVERITIES } from '@/lib/app/questionnaire/evaluation/types';
import { topicKeySchema } from '@/lib/app/questionnaire/scope/schemas';
import {
  MAX_CONDITIONAL_TOPICS_CEILING,
  MAX_OPENING_PROBES_CEILING,
  MAX_SESSION_BUDGET_SECONDS,
  MIN_CONDITIONAL_TOPICS,
  MIN_OPENING_PROBES,
  MIN_SESSION_BUDGET_SECONDS,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_VALUE_MAX_LENGTH,
  TOPIC_CRITERIA_MAX_LENGTH,
  TOPIC_DEPTHS,
  MEMBER_KEY_MAX_LENGTH,
} from '@/lib/app/questionnaire/scope/types';
import type { ScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation/types';

/**
 * Upper bound on findings per judge — same rationale and same number as `MAX_FINDINGS_PER_JUDGE`
 * in `evaluation/judge-schema.ts`, though a scope config (a handful of topics and rules) is far
 * smaller than a long instrument, so this is very unlikely to bind in practice.
 */
export const MAX_SCOPE_FINDINGS_PER_JUDGE = 50;

const TARGET_KEY_MAX = 200;
const PROPOSED_CHANGE_MAX = 2_000;
const RATIONALE_MAX = 2_000;
const SOURCE_QUOTE_MAX = 2_000;

/** A session budget in seconds: 0 (no budget) or within the legal range — mirrors `conditionalTopicsSettingsSchema`. */
const budgetSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SESSION_BUDGET_SECONDS)
  .refine((v) => v === 0 || v >= MIN_SESSION_BUDGET_SECONDS, {
    message: `Must be 0 (no budget) or at least ${MIN_SESSION_BUDGET_SECONDS} seconds`,
  });

/** The rule-field trio shared by `add_rule` and `edit_rule` — one definition, two ops. */
const ruleFieldsSchema = {
  dataSlotKey: z.string().trim().min(1).max(MEMBER_KEY_MAX_LENGTH),
  operator: z.enum(SCOPE_RULE_OPERATORS),
  value: z.string().trim().max(SCOPE_RULE_VALUE_MAX_LENGTH).nullable(),
  action: z.enum(SCOPE_RULE_ACTIONS),
  topicKey: topicKeySchema,
};

/**
 * The structured `proposedEdit` contract — a discriminated union on `op` mirroring
 * {@link ScopeProposedEdit}. Not sent to the provider; parses and validates the model's
 * prompt-guided JSON (see `coerceScopeProposedEdit`).
 */
export const scopeProposedEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('edit_topic_criteria'),
    criteria: z.string().trim().min(1).max(TOPIC_CRITERIA_MAX_LENGTH),
  }),
  z.object({ op: z.literal('edit_topic_depth'), depth: z.enum(TOPIC_DEPTHS) }),
  z.object({ op: z.literal('add_rule'), ...ruleFieldsSchema }),
  z.object({ op: z.literal('edit_rule'), ...ruleFieldsSchema }),
  z.object({ op: z.literal('delete_rule') }),
  z
    .object({
      op: z.literal('adjust_budget'),
      sessionBudgetSeconds: budgetSecondsSchema.optional(),
      maxOpeningProbes: z
        .number()
        .int()
        .min(MIN_OPENING_PROBES)
        .max(MAX_OPENING_PROBES_CEILING)
        .optional(),
      maxConditionalTopics: z
        .number()
        .int()
        .min(MIN_CONDITIONAL_TOPICS)
        .max(MAX_CONDITIONAL_TOPICS_CEILING)
        .optional(),
    })
    .refine(
      (v) =>
        v.sessionBudgetSeconds !== undefined ||
        v.maxOpeningProbes !== undefined ||
        v.maxConditionalTopics !== undefined,
      { message: 'adjust_budget must set at least one field' }
    ),
  z.object({
    op: z.literal('edit_planner_instructions'),
    plannerInstructions: z.string().trim().max(PLANNER_INSTRUCTIONS_MAX_LENGTH),
  }),
  z.object({ op: z.literal('add_fallback_topic'), topicKey: topicKeySchema }),
]);

/**
 * Compile-time parity guard, the same discipline `evaluation/judge-schema.ts` uses: the schema's
 * inferred output must stay mutually assignable to the hand-written {@link ScopeProposedEdit} union.
 */
export type ScopeProposedEditOutput = z.infer<typeof scopeProposedEditSchema>;
type _ScopeParityCheck<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _scopeProposedEditParity: _ScopeParityCheck<ScopeProposedEditOutput, ScopeProposedEdit> =
  true;
void _scopeProposedEditParity;

/**
 * Soft-degrade a raw `proposedEdit` value to a validated {@link ScopeProposedEdit} or `null` — the
 * `coerceProposedEdit` posture. Run at the persist/read seam so one malformed op never sinks the
 * surrounding verdict or finding.
 */
export function coerceScopeProposedEdit(raw: unknown): ScopeProposedEdit | null {
  if (raw === null || raw === undefined) return null;
  const parsed = scopeProposedEditSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** One actionable finding the judge proposes. `proposedEdit` is optional (prose-only ok). */
export const scopeJudgeFindingSchema = z.object({
  targetKey: z.string().min(1).max(TARGET_KEY_MAX),
  severity: z.enum(FINDING_SEVERITIES),
  proposedChange: z.string().min(1).max(PROPOSED_CHANGE_MAX),
  rationale: z.string().min(1).max(RATIONALE_MAX),
  sourceQuote: z.string().max(SOURCE_QUOTE_MAX).optional(),
  proposedEdit: scopeProposedEditSchema.optional(),
});

/** The raw judge output — score + findings. `dimension` is added by the caller. */
export const scopeJudgeVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  findings: z.array(scopeJudgeFindingSchema).max(MAX_SCOPE_FINDINGS_PER_JUDGE),
});

/** The validated raw output (no `dimension` — that's the caller's to stamp). */
export type ScopeJudgeVerdictOutput = z.infer<typeof scopeJudgeVerdictSchema>;

/** Discriminated result of validating a parsed candidate against the contract. */
export type ScopeJudgeVerdictValidation =
  { ok: true; value: ScopeJudgeVerdictOutput } | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link scopeJudgeVerdictSchema}. Returns the typed
 * value or the flat `issues` list (field path + message) — the capability feeds those into its
 * repair-retry prompt.
 */
export function validateScopeJudgeVerdict(parsed: unknown): ScopeJudgeVerdictValidation {
  const result = scopeJudgeVerdictSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}
