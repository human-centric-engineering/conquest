-- Adaptive data-slot selection: add a pgvector embedding column to data slots,
-- plus an HNSW ANN index for cosine-similarity search. The data-slot analogue of
-- the F4.1 app_question_slot embedding (20260604181453_app_question_slot_embedding).
--
-- NOTE: `prisma migrate dev` also generates DROP INDEX statements for the
-- knowledge/message pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding)
-- and a searchVector DROP DEFAULT. Those are PHANTOM diffs — Prisma can't see
-- raw-SQL-managed pgvector objects and tries to drop them on every diff. They were
-- stripped from this hand-authored migration so it does NOT silently degrade
-- existing vector search to seq-scan. See the drift warnings on
-- AppDataSlot / AppQuestionSlot / AiKnowledgeChunk in the Prisma schema.

-- AlterTable: the pgvector column (width matches the platform embedding model).
ALTER TABLE "app_data_slot" ADD COLUMN "embedding" vector(1536);

-- HNSW ANN index for cosine distance (`<=>`). HNSW (not IVFFlat) so the index
-- needs no training data and supports incremental inserts as slots are embedded
-- one version at a time. Params mirror the knowledge / question-slot embedding index.
CREATE INDEX "idx_app_data_slot_embedding"
  ON "app_data_slot"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
