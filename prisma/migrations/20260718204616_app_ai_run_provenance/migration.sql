-- F14.15 (AI run provenance).
--
-- NOTE: `prisma migrate dev` generated five DROP INDEX statements for the pgvector
-- indexes (idx_knowledge_embedding, idx_message_embedding, idx_app_data_slot_embedding,
-- idx_app_question_slot_embedding, idx_ai_knowledge_chunk_search_vector) and a
-- DROP DEFAULT on ai_knowledge_chunk.searchVector. Those objects are created outside
-- the Prisma schema, so every app migration proposes destroying them. They have been
-- stripped by hand -- do not reinstate them.

-- AlterTable
ALTER TABLE "ai_evaluation_run" ADD COLUMN     "agentVersionId" TEXT;

-- AlterTable
ALTER TABLE "app_cohort_report" ADD COLUMN     "methodRecord" JSONB;

-- AlterTable
ALTER TABLE "app_cohort_report_revision" ADD COLUMN     "methodRecord" JSONB;

-- AlterTable
ALTER TABLE "app_questionnaire_extraction_change" ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "app_ai_run" (
    "id" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "versionId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptSnapshot" JSONB,
    "outputSnapshot" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "detail" JSONB,
    "error" TEXT,
    "promptVersion" TEXT,
    "appVersion" TEXT NOT NULL,
    "triggeredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_ai_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_ai_run_subjectKind_subjectId_createdAt_idx" ON "app_ai_run"("subjectKind", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "app_ai_run_versionId_createdAt_idx" ON "app_ai_run"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "app_ai_run_kind_createdAt_idx" ON "app_ai_run"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "app_ai_run_status_createdAt_idx" ON "app_ai_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "app_ai_run_createdAt_idx" ON "app_ai_run"("createdAt");
