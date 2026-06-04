/**
 * Public surface of the questionnaire app module.
 *
 * Barrel re-export so consumers import from `@/lib/app/questionnaire` rather than
 * reaching into individual files. Grows as later phases add sub-modules.
 */
export {
  APP_QUESTIONNAIRES_FLAG,
  ensureQuestionnairesEnabled,
  withQuestionnairesEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
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
