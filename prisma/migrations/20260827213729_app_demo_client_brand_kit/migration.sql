-- Brand kit: the ground a questionnaire is drawn ON, the type it is set in, and the marks
-- that ride on both.
--
-- The existing theme columns brand the CHROME around the conversation (band, CTA, logo
-- backdrop). These brand the conversation itself, which is what any layout other than
-- Classic actually paints with. All six are nullable and every null resolves to today's
-- look in resolveTheme() — neutral canvas, system type, the single lockup — so no
-- existing demo client changes appearance and there is no backfill.
--
-- NOTE: `prisma migrate dev --create-only` also emitted DROP INDEX for the five pgvector
-- indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding, idx_app_data_slot_embedding, idx_app_question_slot_embedding)
-- and a DROP DEFAULT on ai_knowledge_chunk."searchVector". Those are phantom — Prisma
-- cannot see the raw-SQL index definitions — and applying them destroys the knowledge-base
-- and semantic-matching indexes. They have been stripped by hand, as in every other app
-- migration here; a schema-guard test asserts they never leak back in.

-- AlterTable
ALTER TABLE "app_demo_client" ADD COLUMN     "accentColorEnd" TEXT,
ADD COLUMN     "canvasColor" TEXT,
ADD COLUMN     "fontPairing" TEXT,
ADD COLUMN     "inkColor" TEXT,
ADD COLUMN     "logoDarkUrl" TEXT,
ADD COLUMN     "logoMarkUrl" TEXT;
