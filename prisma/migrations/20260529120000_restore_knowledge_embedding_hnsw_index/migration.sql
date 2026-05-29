-- Restore HNSW index on ai_knowledge_chunk.embedding (cosine).
--
-- WHAT happened: this index was originally created in
-- 20260409214649_add_hnsw_vector_index and silently dropped two days later
-- by 20260411133126_add_orchestration_settings — a migration whose actual
-- purpose was adding the ai_orchestration_settings table for the costs/budget
-- dashboard. The DROP INDEX appears as line 2 of that file with no comment
-- justifying it, no replacement, and no relation to the rest of the
-- migration's content.
--
-- WHY it was almost certainly accidental:
--   1. The drop shape matches a `prisma migrate dev` auto-DROP — Prisma
--      sees an index in the dev DB that isn't declared in the schema and
--      emits a DROP. The team later documented this same Prisma behaviour
--      in 20260525072647_evaluations_phase1_foundations, stripping similar
--      auto-DROPs for idx_ai_knowledge_chunk_search_vector and
--      idx_message_embedding. This drop slipped through at review.
--   2. The very next HNSW migration (20260420063847_add_message_embedding_
--      hnsw_index, April 20) writes "Mirrors the existing
--      idx_knowledge_embedding on ai_knowledge_chunk" — written as if the
--      index still existed. The author was unaware it had been dropped 9
--      days earlier.
--   3. scripts/embeddings-reset.ts continues to DROP+CREATE the index by
--      this exact name, treating it as a fixture of the system.
--   4. A retrieval bug reported during the week of 2026-05-26 is consistent
--      with knowledge-base vector lookups falling back to seq-scan over
--      ai_knowledge_chunk — the symptom of the missing HNSW index.
--
-- WHAT this migration does: re-creates the index with the same parameters
-- as the original April 9 migration (m=16, ef_construction=64, cosine
-- operator class). IF NOT EXISTS guards against double-application — a
-- defence in depth if the schema-warning update in the same PR isn't picked
-- up by a future contributor's `prisma migrate dev` workflow.
--
-- See the PRISMA-SCHEMA DRIFT WARNING block in
-- prisma/schema/orchestration-knowledge.prisma for the per-Postgres-object
-- list of Prisma-unmodelled SQL we have to manage outside the schema.

CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
  ON ai_knowledge_chunk
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
