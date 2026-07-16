/**
 * Public surface of the questionnaire app module.
 *
 * Barrel re-export so consumers import from `@/lib/app/questionnaire` rather than
 * reaching into individual files. Grows as later phases add sub-modules.
 */
export {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  APP_QUESTIONNAIRE_STATUSES,
  FIELD_PROVENANCES,
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
  AUDIENCE_FIELDS,
} from '@/lib/app/questionnaire/types';
export type {
  AppQuestionnaireStatus,
  QuestionType,
  FieldProvenance,
  AudienceShape,
  AudienceProvenance,
  AudienceExpertiseLevel,
  AudienceSensitivity,
} from '@/lib/app/questionnaire/types';
export {
  hasLaunchBlockers,
  slugifyKey,
  nextAvailableKey,
  typeConfigSchemaFor,
  validateTypeConfig,
  updateVersionMetaSchema,
  updateVersionStatusSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSchema,
  createQuestionSchema,
  updateQuestionSchema,
} from '@/lib/app/questionnaire/authoring';
export type {
  LaunchBlockers,
  TypeConfigValidation,
  UpdateVersionMetaInput,
  UpdateVersionStatusInput,
  CreateSectionInput,
  UpdateSectionInput,
  ReorderInput,
  CreateQuestionInput,
  UpdateQuestionInput,
} from '@/lib/app/questionnaire/authoring';
export {
  estimateSessionCost,
  effectiveQuestionsPerSession,
  scaleRange,
  SYSTEM_PROMPT_TOKENS,
  HISTORY_TOKENS_PER_PRIOR_TURN,
  OUTPUT_TOKENS_PER_TURN,
  RANGE_LOW_FACTOR,
  RANGE_HIGH_FACTOR,
} from '@/lib/app/questionnaire/cost-estimation';
export type {
  CostRange,
  CostEstimateAssumptions,
  SessionCostEstimate,
  EstimateSessionCostInput,
} from '@/lib/app/questionnaire/cost-estimation';
