-- F4.6 session state machine: the append-only lifecycle audit trail. One
-- AppQuestionnaireSessionEvent row per recorded transition (paused/resumed/
-- completed/abandoned), plus created and the cost_cap_reached hook (fired F6.3/F6.5).
--
-- NOTE: `prisma migrate dev` also generated DROP INDEX statements for the
-- knowledge/message/slot pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding)
-- and a `searchVector` DROP DEFAULT. Those are PHANTOM diffs — Prisma can't see
-- raw-SQL-managed pgvector objects and tries to drop them on every diff. They were
-- stripped from this migration so it does NOT silently degrade vector search to
-- seq-scan. See the drift warnings on AppQuestionSlot / AiKnowledgeChunk.

-- CreateTable
CREATE TABLE "app_questionnaire_session_event" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_session_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_session_event_sessionId_idx" ON "app_questionnaire_session_event"("sessionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_session_event_sessionId_createdAt_idx" ON "app_questionnaire_session_event"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "app_questionnaire_session_event" ADD CONSTRAINT "app_questionnaire_session_event_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
