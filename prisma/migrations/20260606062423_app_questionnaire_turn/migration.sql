-- F6.1 per-turn orchestrator + streaming: the append-only per-turn record. One
-- AppQuestionnaireTurn row per respondent turn over a live session, written by the
-- streaming turn route's seam after the deterministic orchestrator pipeline runs.
-- Anchors the answers a turn produced (AppAnswerSlot.lastUpdatedTurnId points back
-- here) and captures per-turn cost + which capabilities ran.
--
-- NOTE: `prisma migrate dev` also generated DROP INDEX statements for the
-- knowledge/message/slot pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding)
-- and a `searchVector` DROP DEFAULT. Those are PHANTOM diffs — Prisma can't see
-- raw-SQL-managed pgvector objects and tries to drop them on every diff. They were
-- stripped from this migration so it does NOT silently degrade vector search to
-- seq-scan. See the drift warnings on AppQuestionSlot / AiKnowledgeChunk.

-- CreateTable
CREATE TABLE "app_questionnaire_turn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "userMessage" TEXT NOT NULL,
    "agentResponse" TEXT NOT NULL,
    "targetedQuestionId" TEXT,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "sideEffectAnswerIds" JSONB NOT NULL DEFAULT '[]',
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_turn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_sessionId_idx" ON "app_questionnaire_turn"("sessionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_sessionId_ordinal_idx" ON "app_questionnaire_turn"("sessionId", "ordinal");

-- AddForeignKey
ALTER TABLE "app_questionnaire_turn" ADD CONSTRAINT "app_questionnaire_turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
