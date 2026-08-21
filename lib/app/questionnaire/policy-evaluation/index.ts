/**
 * Public surface of the interviewer-policy evaluation core (F18.8).
 *
 * Pure, DB-free: the dimension vocabulary + registry, the judge output contract (Zod), the structure
 * schema, the prompt builder, and the op describer. The `evaluate-policy` capability and the
 * evaluate-preview route consume these; nothing here imports Prisma or Next.js. Sibling of
 * `scope-evaluation/index.ts` — see `types.ts`'s module doc for why this is a separate module rather
 * than an extension of either existing panel.
 */

export {
  POLICY_EVALUATION_DIMENSIONS,
  type PolicyEvaluationDimension,
  POLICY_PROPOSED_EDIT_OPS,
  type PolicyProposedEditOp,
  type PolicyProposedEdit,
  type PolicyJudgeFinding,
  type PolicyJudgeVerdict,
  type PolicyStructureMeta,
  type PolicyStructureContext,
  type PolicyStructureTone,
  type PolicyStructureHouseRules,
  type PolicyStructureStrategy,
  type PolicyStructureQuestion,
  type PolicyStructureFidelity,
  type PolicyStructureRouting,
  type PolicyStructureIssue,
  type PolicyStructureInput,
} from '@/lib/app/questionnaire/policy-evaluation/types';

export {
  type PolicyDimensionSpec,
  POLICY_EVALUATION_DIMENSION_SPECS,
  POLICY_EVALUATION_JUDGE_SLUGS,
  policyDimensionForSlug,
} from '@/lib/app/questionnaire/policy-evaluation/dimensions';

export {
  MAX_POLICY_FINDINGS_PER_JUDGE,
  policyJudgeFindingSchema,
  policyJudgeVerdictSchema,
  policyProposedEditSchema,
  coercePolicyProposedEdit,
  validatePolicyJudgeVerdict,
  buildPolicyJudgeRetryMessage,
  type PolicyJudgeVerdictOutput,
  type PolicyJudgeVerdictValidation,
  type PolicyProposedEditOutput,
} from '@/lib/app/questionnaire/policy-evaluation/judge-schema';

export { buildPolicyJudgePrompt } from '@/lib/app/questionnaire/policy-evaluation/judge-prompt';

export {
  MAX_POLICY_EVAL_QUESTIONS,
  MAX_POLICY_EVAL_RULES,
  MAX_POLICY_EVAL_ISSUES,
  MAX_POLICY_EVAL_TOPICS,
  policyStructureSchema,
} from '@/lib/app/questionnaire/policy-evaluation/structure-schema';

export { describePolicyProposedEdit } from '@/lib/app/questionnaire/policy-evaluation/describe-op';

// `run-panel.ts` is NOT re-exported here, unlike every other leaf module — it imports the capability
// dispatcher, which imports Prisma, which pulls `pg` and its node built-ins (`net`, `tls`, `fs`,
// `dns`) into any bundle that touches this barrel. Three CLIENT components import
// `POLICY_EVALUATION_DIMENSION_SPECS` and `describePolicyProposedEdit` from here, so a re-export
// would break `next build` with "Module not found: net" the moment one of them rendered. Server
// callers import `runPolicyEvaluationPanel` from its own leaf. The scope panel learned this the
// hard way; do not "tidy" it back in.
