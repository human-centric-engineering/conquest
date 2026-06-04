/**
 * Public surface of the questionnaire authoring sub-module (F2.1 / PR2).
 *
 * Pure (no Prisma / Next) building blocks for the structural-authoring mutation
 * routes: launch-blocker seam, key slugging, per-type config validation, and the
 * request-body schemas. The DB-touching fork writer is route-local
 * (`app/api/v1/app/questionnaires/_lib/fork.ts`), keeping this tree storage-agnostic.
 */
export {
  countLaunchBlockers,
  hasLaunchBlockers,
  type LaunchBlockers,
} from '@/lib/app/questionnaire/authoring/launch-blockers';
export { slugifyKey, nextAvailableKey } from '@/lib/app/questionnaire/authoring/key';
export {
  typeConfigSchemaFor,
  validateTypeConfig,
  defaultTypeConfig,
  type TypeConfigValidation,
} from '@/lib/app/questionnaire/authoring/type-config-schema';
export {
  updateVersionMetaSchema,
  updateVersionStatusSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSchema,
  createQuestionSchema,
  updateQuestionSchema,
  type UpdateVersionMetaInput,
  type UpdateVersionStatusInput,
  type CreateSectionInput,
  type UpdateSectionInput,
  type ReorderInput,
  type CreateQuestionInput,
  type UpdateQuestionInput,
} from '@/lib/app/questionnaire/authoring/schemas';
export {
  updateConfigSchema,
  profileFieldSchema,
  type UpdateConfigInput,
} from '@/lib/app/questionnaire/authoring/config-schema';
