/**
 * The interviewer-policy judge output contract (F18.8) — Zod, plus the parity guard.
 *
 * Mirrors `scope-evaluation/judge-schema.ts` in structure and in discipline: a hand-written union in
 * `types.ts` for readability, a discriminated Zod union here for validation, and a compile-time
 * mutual-assignability check that fails the build the moment the two drift.
 *
 * **The field schemas are borrowed, never re-declared.** `houseRuleBodySchema` comes from
 * `authoring/config-schema.ts` — the same schema the config PATCH validates against — so a judge's
 * proposed rule is held to exactly the invariant a saved rule is, above all the one it gets wrong
 * most often: `trigger` belongs to `if_asked` and to nothing else. Reusing it means
 * {@link coercePolicyProposedEdit} degrades a malformed rule to prose-only rather than handing the
 * apply engine something the config route would 400 on.
 */

import { z } from 'zod';

import { FINDING_SEVERITIES, type FindingSeverity } from '@/lib/app/questionnaire/evaluation/types';
import {
  FUNNEL_PACES,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_OPENING_MODES,
  QUESTION_FIDELITY_STOPS,
  TONE_DIMENSION_KEYS,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
} from '@/lib/app/questionnaire/types';
import { houseRuleBodySchema } from '@/lib/app/questionnaire/authoring/config-schema';
import type {
  PolicyEvaluationDimension,
  PolicyJudgeFinding,
  PolicyJudgeVerdict,
  PolicyProposedEdit,
} from '@/lib/app/questionnaire/policy-evaluation/types';

/** Hard ceiling on findings from ONE judge, so a runaway verdict cannot flood the review queue. */
export const MAX_POLICY_FINDINGS_PER_JUDGE = 50;

const TARGET_KEY_MAX = 200;
const PROPOSED_CHANGE_MAX = 2_000;
const RATIONALE_MAX = 2_000;
const SOURCE_QUOTE_MAX = 2_000;

/**
 * The five-stop grid as a Zod enum. A judge picks a stop, never an arbitrary float — the runtime
 * clamps on read anyway, but accepting 0.37 here would let a finding claim a level that does not
 * exist and then apply as something else.
 */
const fidelityStopSchema = z.literal(QUESTION_FIDELITY_STOPS);

export const policyProposedEditSchema = z.discriminatedUnion('op', [
  houseRuleBodySchema.safeExtend({ op: z.literal('edit_house_rule') }),
  z.object({ op: z.literal('set_house_rule_enabled'), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('delete_house_rule') }).strict(),
  houseRuleBodySchema.safeExtend({ op: z.literal('add_house_rule') }),
  z.object({ op: z.literal('set_approach'), approach: z.enum(INTERVIEWER_APPROACHES) }).strict(),
  z.object({ op: z.literal('set_pace'), pace: z.enum(FUNNEL_PACES) }).strict(),
  z
    .object({ op: z.literal('set_opening_mode'), openingMode: z.enum(INTERVIEWER_OPENING_MODES) })
    .strict(),
  z
    .object({
      op: z.literal('set_tactics'),
      probeDepth: z.boolean().optional(),
      reflect: z.boolean().optional(),
      batchRelated: z.boolean().optional(),
    })
    .strict()
    // At least one tactic, or the op is a no-op dressed as a change.
    .refine(
      (v) => v.probeDepth !== undefined || v.reflect !== undefined || v.batchRelated !== undefined,
      { message: 'Name at least one tactic to change' }
    ),
  z.object({ op: z.literal('set_fidelity_enabled'), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('set_default_fidelity'), defaultFidelity: fidelityStopSchema }).strict(),
  z.object({ op: z.literal('set_question_fidelity'), fidelity: fidelityStopSchema }).strict(),
  z
    .object({
      op: z.literal('set_tone_dimension'),
      dimension: z.enum(TONE_DIMENSION_KEYS),
      enabled: z.boolean(),
      level: z.number().int().min(TONE_LEVEL_MIN).max(TONE_LEVEL_MAX).optional(),
    })
    .strict(),
]);

export type PolicyProposedEditOutput = z.infer<typeof policyProposedEditSchema>;

/**
 * Compile-time parity between the hand-written union and the Zod one. If either gains an op the
 * other lacks — or a field shape drifts — this stops compiling. Cheaper than a test, and it fires at
 * the moment of the mistake rather than on the next run.
 */
type ParityCheck<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _policyProposedEditParity: ParityCheck<PolicyProposedEditOutput, PolicyProposedEdit> = true;
void _policyProposedEditParity;

export const policyJudgeFindingSchema = z
  .object({
    targetKey: z.string().trim().min(1).max(TARGET_KEY_MAX),
    severity: z.enum(FINDING_SEVERITIES),
    proposedChange: z.string().trim().min(1).max(PROPOSED_CHANGE_MAX),
    rationale: z.string().trim().min(1).max(RATIONALE_MAX),
    sourceQuote: z.string().trim().max(SOURCE_QUOTE_MAX).optional(),
    proposedEdit: policyProposedEditSchema.optional(),
  })
  .strict();

/**
 * `dimension` is deliberately absent: the caller stamps it from the dispatch it made, so a judge can
 * never mislabel its own verdict. Same rule both sibling panels follow.
 */
export const policyJudgeVerdictSchema = z
  .object({
    score: z.number().min(0).max(1),
    findings: z.array(policyJudgeFindingSchema).max(MAX_POLICY_FINDINGS_PER_JUDGE),
  })
  .strict();

export type PolicyJudgeVerdictOutput = z.infer<typeof policyJudgeVerdictSchema>;

export type PolicyJudgeVerdictValidation =
  { ok: true; value: PolicyJudgeVerdictOutput } | { ok: false; issues: z.core.$ZodIssue[] };

/** Validate a parsed judge response, returning the issues so the caller can build a retry message. */
export function validatePolicyJudgeVerdict(parsed: unknown): PolicyJudgeVerdictValidation {
  const result = policyJudgeVerdictSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * Coerce a raw `proposedEdit` at persist time, or `null` when it cannot be salvaged.
 *
 * Soft-degrade, never throw: a finding whose structured edit is malformed is still a real finding
 * worth showing — it simply becomes prose-only and the reviewer applies it by hand. Dropping the
 * whole finding because a judge mis-shaped one field would lose the observation as well as the fix.
 */
export function coercePolicyProposedEdit(raw: unknown): PolicyProposedEdit | null {
  const result = policyProposedEditSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Build the retry message for a judge whose first response failed validation. */
export function buildPolicyJudgeRetryMessage(issuePaths: string[]): string {
  const paths = issuePaths.length > 0 ? issuePaths.join(', ') : 'the response shape';
  return (
    `Your previous response did not match the required JSON schema (problems at: ${paths}). ` +
    'Return ONLY the corrected JSON object — no prose, no code fence.'
  );
}

/** Re-exported so the panel can stamp a verdict without importing two modules. */
export type { FindingSeverity, PolicyEvaluationDimension, PolicyJudgeFinding, PolicyJudgeVerdict };
