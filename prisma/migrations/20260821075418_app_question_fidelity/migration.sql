-- Question fidelity: the per-question "ask it as written ↔ fill it creatively" dial, plus the
-- version-level gate that activates it.
--
-- Both defaults are deliberately no-ops: 0.5 is the `balanced` stop (today's behaviour), and an
-- empty gate object narrows to `{ enabled: false }`, so existing questionnaires are unchanged.
--
-- NOTE: `prisma migrate dev` also generates DROP INDEX statements for the five pgvector/tsvector
-- indexes (they are created by raw SQL that the Prisma schema cannot express) and a DROP DEFAULT on
-- ai_knowledge_chunk.searchVector. Those are phantom diffs, not intended changes, and have been
-- stripped by hand. Do not re-add them.

-- AlterTable
ALTER TABLE "app_question_slot" ADD COLUMN     "fidelity" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "questionFidelity" JSONB NOT NULL DEFAULT '{}';
