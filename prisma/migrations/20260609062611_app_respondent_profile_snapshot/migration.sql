-- F8.3: respondent profile snapshot (PII, 1:1 with a non-anonymous session).
--
-- The Prisma-generated diff also emitted phantom DROPs for four raw-SQL objects it
-- cannot model (the pgvector HNSW / search indexes
-- idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding, idx_app_question_slot_embedding, and the
-- ai_knowledge_chunk.searchVector default). Those were stripped — this migration
-- only creates the new table. See the drift warnings in the schema + the
-- app-migration create-only discipline.

-- CreateTable
CREATE TABLE "app_respondent_profile_snapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "respondentUserId" TEXT,
    "values" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_respondent_profile_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_respondent_profile_snapshot_sessionId_key" ON "app_respondent_profile_snapshot"("sessionId");

-- CreateIndex
CREATE INDEX "app_respondent_profile_snapshot_respondentUserId_idx" ON "app_respondent_profile_snapshot"("respondentUserId");

-- AddForeignKey
ALTER TABLE "app_respondent_profile_snapshot" ADD CONSTRAINT "app_respondent_profile_snapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_respondent_profile_snapshot" ADD CONSTRAINT "app_respondent_profile_snapshot_respondentUserId_fkey" FOREIGN KEY ("respondentUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
