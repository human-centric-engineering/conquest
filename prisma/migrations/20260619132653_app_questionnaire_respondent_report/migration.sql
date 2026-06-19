-- Respondent Report (report kind `respondent`): the per-version config slice, the per-client
-- knowledge tag pointer, and the stored mode-2 report table.
--
-- Schema-fold strip applied by hand: `prisma migrate dev` re-emitted DROPs of the platform's
-- pgvector indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding, idx_app_data_slot_embedding, idx_app_question_slot_embedding) and an ALTER
-- of the GENERATED ai_knowledge_chunk."searchVector" column — Prisma-unmodelled objects with no
-- bearing on these additive changes. They are removed so this migration is clean; the schema-guard
-- test asserts they never leak back in.

-- AlterTable
ALTER TABLE "app_demo_client" ADD COLUMN     "knowledgeTagId" TEXT;

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "respondentReport" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "app_respondent_report" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "content" JSONB,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_respondent_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_respondent_report_sessionId_key" ON "app_respondent_report"("sessionId");

-- CreateIndex
CREATE INDEX "app_respondent_report_status_lockedAt_idx" ON "app_respondent_report"("status", "lockedAt");

-- AddForeignKey
ALTER TABLE "app_respondent_report" ADD CONSTRAINT "app_respondent_report_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
