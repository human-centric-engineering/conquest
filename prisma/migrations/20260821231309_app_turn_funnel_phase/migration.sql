-- Interviewer funnel arc: how far through its open → mixed → targeted arc each turn fell, and the
-- coverage ratio that decided it. Both nullable — every turn written before this column is unknown,
-- not zero, and every reader must treat it that way.
--
-- NOTE: `prisma migrate dev` also generates DROP INDEX statements for the five pgvector/tsvector
-- indexes (created by raw SQL the Prisma schema cannot express) and a DROP DEFAULT on
-- ai_knowledge_chunk.searchVector. Those are phantom diffs and have been stripped by hand.

-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "coverage" DOUBLE PRECISION,
ADD COLUMN     "funnelPhase" TEXT;
