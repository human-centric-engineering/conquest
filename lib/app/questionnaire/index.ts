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
export type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
