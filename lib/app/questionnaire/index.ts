/**
 * Public surface of the questionnaire app module.
 *
 * Barrel re-export so consumers import from `@/lib/app/questionnaire` rather than
 * reaching into individual files. Grows as later phases add sub-modules.
 */
export {
  APP_QUESTIONNAIRES_FLAG,
  ensureQuestionnairesEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
export {
  QUESTION_TYPES,
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
export type {
  AppQuestionnaireStatus,
  QuestionType,
  AudienceShape,
  AudienceExpertiseLevel,
  AudienceSensitivity,
} from '@/lib/app/questionnaire/types';
