-- F4.4 answer refinement: the persistence foundation — a minimal
-- AppQuestionnaireSession plus AppAnswerSlot (with refinementHistory), the slice of
-- F4.6's session machinery F4.4 needs to write refinements.
--
-- NOTE: `prisma migrate dev` also generated DROP INDEX statements for the
-- knowledge/message/slot pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding)
-- and a `searchVector` DROP DEFAULT. Those are PHANTOM diffs — Prisma can't see
-- raw-SQL-managed pgvector objects and tries to drop them on every diff. They were
-- stripped from this migration so it does NOT silently degrade vector search to
-- seq-scan. See the drift warnings on AppQuestionSlot / AiKnowledgeChunk.

-- CreateTable
CREATE TABLE "app_questionnaire_session" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "respondentUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_answer_slot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionSlotId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "provenanceLabel" TEXT NOT NULL DEFAULT 'direct',
    "provenanceItems" JSONB,
    "rationale" TEXT,
    "lastUpdatedTurnId" TEXT,
    "refinementHistory" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_answer_slot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_session_versionId_idx" ON "app_questionnaire_session"("versionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_session_versionId_isPreview_idx" ON "app_questionnaire_session"("versionId", "isPreview");

-- CreateIndex
CREATE INDEX "app_answer_slot_sessionId_idx" ON "app_answer_slot"("sessionId");

-- CreateIndex
CREATE INDEX "app_answer_slot_questionSlotId_idx" ON "app_answer_slot"("questionSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "app_answer_slot_sessionId_questionSlotId_key" ON "app_answer_slot"("sessionId", "questionSlotId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_session" ADD CONSTRAINT "app_questionnaire_session_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_answer_slot" ADD CONSTRAINT "app_answer_slot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_answer_slot" ADD CONSTRAINT "app_answer_slot_questionSlotId_fkey" FOREIGN KEY ("questionSlotId") REFERENCES "app_question_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
