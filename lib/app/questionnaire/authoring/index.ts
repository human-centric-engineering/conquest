/**
 * Public surface of the questionnaire authoring sub-module (F2.1 / PR2).
 *
 * Pure (no Prisma / Next) building blocks for the structural-authoring mutation
 * routes: launch-blocker seam, key slugging, per-type config validation, and the
 * request-body schemas. The DB-touching fork writer is route-local
 * (`app/api/v1/app/questionnaires/_lib/fork.ts`), keeping this tree storage-agnostic.
 */
export {
  hasLaunchBlockers,
  type LaunchBlockers,
} from '@/lib/app/questionnaire/authoring/launch-blockers';
export { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
export {
  typeConfigSchemaFor,
  validateTypeConfig,
  defaultTypeConfig,
  hasCompleteLikertLabels,
  isLikertLabelled,
  type TypeConfigValidation,
} from '@/lib/app/questionnaire/authoring/type-config-schema';
export {
  questionConfigIssue,
  type QuestionConfigIssue,
} from '@/lib/app/questionnaire/authoring/config-health';
export {
  updateVersionMetaSchema,
  updateVersionStatusSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSchema,
  createQuestionSchema,
  updateQuestionSchema,
  bulkSetRequiredSchema,
  type UpdateVersionMetaInput,
  type UpdateVersionStatusInput,
  type CreateSectionInput,
  type UpdateSectionInput,
  type ReorderInput,
  type CreateQuestionInput,
  type UpdateQuestionInput,
  type BulkSetRequiredInput,
} from '@/lib/app/questionnaire/authoring/schemas';
export {
  updateConfigSchema,
  profileFieldSchema,
  type UpdateConfigInput,
} from '@/lib/app/questionnaire/authoring/config-schema';
export {
  CONFIG_EXPORT_KIND,
  CONFIG_EXPORT_SCHEMA_VERSION,
  CONFIG_KEYS,
  extractConfig,
  buildSettingsExport,
  parseSettingsImport,
  type SettingsExport,
  type SettingsImport,
} from '@/lib/app/questionnaire/authoring/config-export';
export {
  DEFINITION_EXPORT_KIND,
  DEFINITION_EXPORT_SCHEMA_VERSION,
  buildDefinitionExport,
  parseDefinitionImport,
  definitionImportSchema,
  type DefinitionExport,
  type DefinitionImport,
  type DefinitionTag,
  type DefinitionQuestion,
  type DefinitionSection,
  type DefinitionDataSlot,
} from '@/lib/app/questionnaire/authoring/definition-export';
