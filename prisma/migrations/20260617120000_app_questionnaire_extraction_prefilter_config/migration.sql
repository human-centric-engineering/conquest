-- Move the extraction candidate pre-filter from a platform feature flag to a per-questionnaire
-- Settings toggle (consistent with answerFitMode / contradictionMode — config, not a flag).
--
-- Hand-authored (single ADD COLUMN) so `prisma migrate dev` does NOT also emit its phantom
-- DROP INDEX statements for the raw-SQL-managed pgvector indexes (idx_*_embedding,
-- idx_ai_knowledge_chunk_search_vector) — Prisma can't see those and tries to drop them on every
-- diff. See the drift notes on AppQuestionSlot / AppDataSlot / AiKnowledgeChunk.

ALTER TABLE "app_questionnaire_config" ADD COLUMN "extractionPrefilter" BOOLEAN NOT NULL DEFAULT false;
