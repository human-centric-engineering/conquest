-- The client's ground in DARK mode.
--
-- The brand kit gave a demo client its own canvas; this makes that canvas survive the respondent
-- switching modes, which they can now do from any layout. Both columns are nullable and both nulls
-- are the common case: resolveTheme derives a dark ground from the light one (the brand colour
-- tinted down over near-black) and derives its ink for contrast. They exist for the client whose
-- brand specifies its own dark palette and for whom our derivation is not it.
--
-- No backfill, and nothing changes for an existing client: a demo client with no canvas at all
-- still resolves to the neutral respondent canvas in both modes.
--
-- NOTE: `prisma migrate dev --create-only` also emitted DROP INDEX for the five pgvector indexes
-- (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding, idx_message_embedding,
-- idx_app_data_slot_embedding, idx_app_question_slot_embedding) and a DROP DEFAULT on
-- ai_knowledge_chunk."searchVector". Those are phantom — Prisma cannot see the raw-SQL index
-- definitions — and applying them destroys the knowledge-base and semantic-matching indexes. They
-- have been stripped by hand, as in every other app migration here; a schema-guard test asserts
-- they never leak back in.

-- AlterTable
ALTER TABLE "app_demo_client" ADD COLUMN     "canvasColorDark" TEXT,
ADD COLUMN     "inkColorDark" TEXT;
