/**
 * Public surface of the questionnaire design-time evaluation core (F5.1).
 *
 * Pure, DB-free: the dimension vocabulary + registry, the judge output contract (Zod +
 * JSON-schema), and the prompt builder. The `evaluate-structure` capability, the
 * preview route, and the judge seed consume these; nothing here imports Prisma /
 * Next.js. Persistence (the run + suggestion models) and the review queue are F5.2 /
 * F5.3.
 */

export {
  EVALUATION_DIMENSIONS,
  type EvaluationDimension,
  FINDING_SEVERITIES,
  type FindingSeverity,
  FINDING_REVIEW_STATUSES,
  type FindingReviewStatus,
  FINDING_APPLICABILITIES,
  type FindingApplicability,
  PROPOSED_EDIT_OPS,
  type ProposedEditOp,
  type ProposedEdit,
  type JudgeFinding,
  type JudgeVerdict,
  type StructureQuestion,
  type StructureSection,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation/types';

export {
  type DimensionSpec,
  EVALUATION_DIMENSION_SPECS,
  EVALUATION_JUDGE_SLUGS,
  dimensionForSlug,
} from '@/lib/app/questionnaire/evaluation/dimensions';

export {
  MAX_FINDINGS_PER_JUDGE,
  judgeFindingSchema,
  judgeVerdictSchema,
  judgeVerdictJsonSchema,
  proposedEditSchema,
  coerceProposedEdit,
  validateJudgeVerdict,
  type JudgeVerdictOutput,
  type JudgeVerdictValidation,
} from '@/lib/app/questionnaire/evaluation/judge-schema';

export {
  buildJudgePrompt,
  buildJudgeRetryMessage,
} from '@/lib/app/questionnaire/evaluation/judge-prompt';

export {
  reviewFindingSchema,
  type ReviewFindingInput,
} from '@/lib/app/questionnaire/evaluation/review-schema';

export {
  MAX_EVAL_SECTIONS,
  MAX_EVAL_QUESTIONS_PER_SECTION,
  audienceShapeSchema,
  structureQuestionSchema,
  structureSectionSchema,
  versionStructureSchema,
  parseAudienceShape,
} from '@/lib/app/questionnaire/evaluation/structure-schema';
