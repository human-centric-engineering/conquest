-- Sectioned interviews (P21): the version's `sections` settings blob.
--
-- Hand-trimmed. `prisma migrate dev` also generated five `DROP INDEX` statements for the pgvector
-- HNSW indexes and a `DROP DEFAULT` on `ai_knowledge_chunk.searchVector`, none of which are real:
-- those objects are created by raw SQL because Prisma cannot model `Unsupported("vector(1536)")`,
-- so every migration it generates proposes dropping them. Applying that would take out adaptive
-- question selection, adaptive data-slot selection and knowledge search at once.
ALTER TABLE "app_questionnaire_config" ADD COLUMN "sections" JSONB NOT NULL DEFAULT '{}';
