-- Question fidelity (P18): which question's real answer control was rendered inside a turn, so the
-- card replays when a respondent resumes or scrolls back. Nullable — the overwhelming majority of
-- turns have no card.
--
-- NOTE: `prisma migrate dev` also generates DROP INDEX statements for the five pgvector/tsvector
-- indexes (created by raw SQL the Prisma schema cannot express) and a DROP DEFAULT on
-- ai_knowledge_chunk.searchVector. Those are phantom diffs and have been stripped by hand.

-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "questionCardKey" TEXT;
