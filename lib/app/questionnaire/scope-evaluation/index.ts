/**
 * Public surface of the Adaptive Scope evaluation core (F17.21).
 *
 * Pure, DB-free: the dimension vocabulary + registry, the judge output contract (Zod), and the
 * prompt builder. The `evaluate-scope` capability and the evaluate-preview route consume these;
 * nothing here imports Prisma / Next.js. Sibling of `evaluation/index.ts` — see `types.ts`'s module
 * doc for why this is a separate module rather than an extension of it.
 */

export {
  SCOPE_EVALUATION_DIMENSIONS,
  type ScopeEvaluationDimension,
  SCOPE_PROPOSED_EDIT_OPS,
  type ScopeProposedEditOp,
  type ScopeProposedEdit,
  type ScopeJudgeFinding,
  type ScopeJudgeVerdict,
  type ScopeStructureTopic,
  type ScopeStructureRule,
  type ScopeStructureSettings,
  type ScopeStructureCosts,
  type ScopeStructureIssue,
  type ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation/types';

export {
  type ScopeDimensionSpec,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  SCOPE_EVALUATION_JUDGE_SLUGS,
  scopeDimensionForSlug,
} from '@/lib/app/questionnaire/scope-evaluation/dimensions';

export {
  MAX_SCOPE_FINDINGS_PER_JUDGE,
  scopeJudgeFindingSchema,
  scopeJudgeVerdictSchema,
  scopeProposedEditSchema,
  coerceScopeProposedEdit,
  validateScopeJudgeVerdict,
  type ScopeJudgeVerdictOutput,
  type ScopeJudgeVerdictValidation,
  type ScopeProposedEditOutput,
} from '@/lib/app/questionnaire/scope-evaluation/judge-schema';

export {
  buildScopeJudgePrompt,
  buildScopeJudgeRetryMessage,
} from '@/lib/app/questionnaire/scope-evaluation/judge-prompt';

export {
  MAX_SCOPE_EVAL_TOPICS,
  MAX_SCOPE_EVAL_MEMBERS_PER_TOPIC,
  MAX_SCOPE_EVAL_RULES,
  MAX_SCOPE_EVAL_ISSUES,
  scopeStructureSchema,
} from '@/lib/app/questionnaire/scope-evaluation/structure-schema';

export {
  runScopeEvaluationPanel,
  type ScopeDimensionResult,
  type ScopeEvaluationPanelSummary,
  type ScopeEvaluationPanelResult,
  type ScopeJudgeAgentRef,
} from '@/lib/app/questionnaire/scope-evaluation/run-panel';
