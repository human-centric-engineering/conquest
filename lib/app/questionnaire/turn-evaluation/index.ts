/**
 * Public surface of the turn-evaluation core.
 *
 * The interview-quality evaluator the Preview Turn Inspector runs over ONE completed turn:
 * the hybrid output contract (Zod + JSON-schema), the prompt builder, the Markdown
 * serializer, the input types, and the `evaluateTurn` service. The evaluate-turn route and
 * the inspector drawer consume these. The pure pieces (types, schema, prompt, serialize)
 * import no Prisma / Next; `evaluate-turn` adds the orchestration LLM helpers.
 */

export type {
  TurnEvaluationContext,
  TurnEvaluationInput,
} from '@/lib/app/questionnaire/turn-evaluation/types';

export {
  TURN_EFFECTIVENESS,
  type TurnEffectiveness,
  CONFIDENCE_QUALITY,
  type ConfidenceQuality,
  INFO_GAIN_RATING,
  type InfoGainRating,
  PROMPT_DRIFT_RATING,
  type PromptDriftRating,
  EFFICIENCY_RATING,
  type EfficiencyRating,
  MAX_EVALUATED_CALLS,
  callEvaluationSchema,
  type CallEvaluation,
  interviewerEvaluationSchema,
  extractionEvaluationSchema,
  questionSelectionEvaluationSchema,
  informationGainSchema,
  promptDriftSchema,
  efficiencySchema,
  turnSummarySchema,
  turnEvaluationSchema,
  type TurnEvaluation,
  turnEvaluationJsonSchema,
  type TurnEvaluationValidation,
  validateTurnEvaluation,
  buildTurnEvaluatorRetryMessage,
} from '@/lib/app/questionnaire/turn-evaluation/schema';

export { buildTurnEvaluatorPrompt } from '@/lib/app/questionnaire/turn-evaluation/prompt';

export { serializeTurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/serialize';

export {
  evaluateTurn,
  type TurnEvaluationResult,
  type EvaluateTurnOptions,
} from '@/lib/app/questionnaire/turn-evaluation/evaluate-turn';
