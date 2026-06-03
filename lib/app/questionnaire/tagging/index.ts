/**
 * Public surface of the questionnaire tagging sub-module (F2.2).
 *
 * Pure (no Prisma / Next) building blocks for the tag mutation routes: label
 * normalisation and the request-body schemas. The DB-touching writes and the
 * same-version assignment check are route-local
 * (`app/api/v1/app/questionnaires/_lib/tagging-routes.ts`), keeping this tree
 * storage-agnostic — the same split the authoring sub-module uses.
 */
export { normalizeTagLabel } from '@/lib/app/questionnaire/tagging/normalize';
export {
  createTagSchema,
  updateTagSchema,
  setQuestionTagsSchema,
  type CreateTagInput,
  type UpdateTagInput,
  type SetQuestionTagsInput,
} from '@/lib/app/questionnaire/tagging/schemas';
