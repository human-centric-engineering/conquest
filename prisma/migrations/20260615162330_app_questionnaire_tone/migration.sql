-- F-tone: interviewer tone & persona settings on the version config.
--
-- Schema-fold strip applied by hand: `prisma migrate dev` re-emitted DROPs of the
-- platform's pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding)
-- and an ALTER of the GENERATED ai_knowledge_chunk."searchVector" column —
-- Prisma-unmodelled objects with no bearing on this column add. They are removed so
-- this migration is a clean additive ALTER; the schema-guard test asserts they never
-- leak back in.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "tone" JSONB NOT NULL DEFAULT '{}';
