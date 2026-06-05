-- F5.3 (suggestion review): structured edit + review-decision columns on evaluation findings,
-- plus a structure snapshot on the run for precise read-time staleness derivation.
--
-- Hand-trimmed: `prisma migrate dev` also emitted DROP INDEX / ALTER statements against
-- PLATFORM objects it can't model — the pgvector HNSW indexes
-- (`idx_ai_knowledge_chunk_search_vector`, `idx_knowledge_embedding`, `idx_message_embedding`,
-- `idx_app_question_slot_embedding`) and the `ai_knowledge_chunk.searchVector` default. Those
-- are managed by raw SQL elsewhere and are NOT part of this change; re-running them here would
-- drop live indexes. Removed. Only the additive, nullable column adds below belong to F5.3 — no
-- backfill, safe on existing rows.

-- AlterTable
ALTER TABLE "app_questionnaire_evaluation_finding" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "appliedToVersionId" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedByUserId" TEXT,
ADD COLUMN     "editedOverride" JSONB,
ADD COLUMN     "proposedEdit" JSONB;

-- AlterTable
ALTER TABLE "app_questionnaire_evaluation_run" ADD COLUMN     "structureSnapshot" JSONB;
