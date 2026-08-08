-- Definitions / glossary (P16): the three per-version switches for how curated terms are used.
--
-- NOTE: `prisma migrate dev` emitted phantom DDL ahead of this block — DROP INDEX on the five
-- pgvector/tsvector indexes and a DROP DEFAULT on ai_knowledge_chunk.searchVector. Those objects
-- are managed by raw SQL Prisma's differ cannot see, so it proposes dropping them on every diff
-- run. They were removed by hand. Do not reinstate them.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "glossaryPromptInjection" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "glossaryReportAppendix" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "glossaryRespondentHints" BOOLEAN NOT NULL DEFAULT true;
