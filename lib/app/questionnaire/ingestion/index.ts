/**
 * Public surface of the questionnaire ingestion core (F1.1).
 *
 * Pure, DB-free extraction contract: the Zod schema + its JSON-schema, the
 * prompt builder, and the change-record normaliser. The extractor capability
 * (PR3) and the route (PR4) consume these; nothing here imports Prisma/Next.js.
 */

export {
  extractionSchema,
  extractionJsonSchema,
  audienceShapeSchema,
  validateExtraction,
  type ExtractionResult,
  type ExtractionValidation,
  type ExtractedSection,
  type ExtractedQuestion,
  type ExtractedChange,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';

export {
  buildExtractionPrompt,
  buildExtractionRetryMessage,
  adminSuppliedFieldPaths,
  type BuildExtractionPromptInput,
} from '@/lib/app/questionnaire/ingestion/extraction-prompt';

export {
  normalizeChangeRecords,
  type NormalizeChangeRecordsResult,
  type DroppedChange,
} from '@/lib/app/questionnaire/ingestion/change-records';

export {
  CHANGE_TYPES,
  TARGET_ENTITY_TYPES,
  PRUNE_CHANGE_TYPES,
  INFER_CHANGE_TYPES,
  type ChangeType,
  type TargetEntityType,
  type InferChangeType,
  type AdminSuppliedMetadata,
  type ChangeRecordIntent,
} from '@/lib/app/questionnaire/ingestion/types';
