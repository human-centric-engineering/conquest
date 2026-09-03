/**
 * Public surface of the Conditional Topics evaluation core (F17.21).
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
  MAX_SCOPE_EVAL_ISSUES,
  scopeStructureSchema,
} from '@/lib/app/questionnaire/scope-evaluation/structure-schema';

// `run-panel.ts` is NOT re-exported here, unlike every other leaf module — it imports the
// capability dispatcher, which imports Prisma. A client component importing anything from this
// barrel (e.g. `scope-evaluation-card.tsx` for `SCOPE_EVALUATION_DIMENSION_SPECS`) would pull the
// whole `pg` driver into the browser bundle. Server-side callers (the evaluate-preview and
// evaluations routes) import `runScopeEvaluationPanel` directly from
// `@/lib/app/questionnaire/scope-evaluation/run-panel` — mirrors `evaluation/index.ts`'s identical
// omission of its own `run-panel.ts`.

export {
  scopeReviewFindingSchema,
  type ScopeReviewFindingInput,
} from '@/lib/app/questionnaire/scope-evaluation/review-schema';

export {
  SCOPE_GROUP_SORTS,
  groupScopeFindingsByTarget,
  tallyScopeSeverities,
  type ScopeGroupSort,
  type ScopeFindingGroup,
  type ScopeSeverityCounts,
} from '@/lib/app/questionnaire/scope-evaluation/group-findings';

export { describeScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation/describe-op';
