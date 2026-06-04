-- F4.1 adaptive selection: add a pgvector embedding column to question slots,
-- plus an HNSW ANN index for cosine-similarity search.
--
-- NOTE: `prisma migrate dev` also generated DROP INDEX statements for the
-- knowledge/message pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding) and a searchVector DROP DEFAULT.
-- Those are PHANTOM diffs — Prisma can't see raw-SQL-managed pgvector objects and
-- tries to drop them on every diff. They were stripped from this migration so it
-- does NOT silently degrade existing vector search to seq-scan. See the drift
-- warnings on AppQuestionSlot / AiKnowledgeChunk in the Prisma schema.

-- AlterTable: the pgvector column (width matches the platform embedding model).
ALTER TABLE "app_question_slot" ADD COLUMN "embedding" vector(1536);

-- HNSW ANN index for cosine distance (`<=>`). HNSW (not IVFFlat) so the index
-- needs no training data and supports incremental inserts as slots are embedded
-- one version at a time. Params mirror the knowledge embedding index.
CREATE INDEX "idx_app_question_slot_embedding"
  ON "app_question_slot"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
