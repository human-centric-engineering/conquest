-- Question selection weight moves to a bounded 0.1–1.0 slider with a neutral 0.5 midpoint.
--
-- (Prisma's diff also wanted to DROP the pgvector / tsvector indexes it can't model
-- — idx_*_embedding, idx_ai_knowledge_chunk_search_vector — and drop the searchVector
-- generated default. Those are phantom DDL and have been stripped; this migration only
-- changes the question weight default and backfills existing rows.)

-- New default for any question created without an explicit weight (ingestion, API, editor).
ALTER TABLE "app_question_slot" ALTER COLUMN "weight" SET DEFAULT 0.5;

-- Backfill: bring every pre-existing question onto the new neutral default.
UPDATE "app_question_slot" SET "weight" = 0.5;
