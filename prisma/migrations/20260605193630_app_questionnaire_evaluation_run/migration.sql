-- F5.2 — design-time evaluation run + finding persistence.
--
-- App-owned tables for the synchronous judge-panel run (the F5.1 dispatch seam) and its
-- per-finding rows. NOTE: Prisma 7 emitted phantom DROP INDEX / ALTER TABLE statements
-- against unmodelled platform pgvector objects (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding, and the
-- ai_knowledge_chunk.searchVector GENERATED default) — those were hand-stripped per the
-- app-migration workflow (see 20260601144112_app_questionnaire_ingestion). Only the new
-- CREATE TABLE / CREATE INDEX / ADD CONSTRAINT statements below are kept.

-- CreateTable
CREATE TABLE "app_questionnaire_evaluation_run" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "triggeredByUserId" TEXT,
    "dimensionsRequested" INTEGER NOT NULL,
    "dimensionsRun" INTEGER NOT NULL,
    "dimensionsFailed" INTEGER NOT NULL,
    "totalFindings" INTEGER NOT NULL DEFAULT 0,
    "dimensionSummary" JSONB NOT NULL,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_evaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_evaluation_finding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "targetKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "proposedChange" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "sourceQuote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_evaluation_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_run_versionId_createdAt_idx" ON "app_questionnaire_evaluation_run"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_run_questionnaireId_idx" ON "app_questionnaire_evaluation_run"("questionnaireId");

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_run_status_idx" ON "app_questionnaire_evaluation_run"("status");

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_finding_runId_idx" ON "app_questionnaire_evaluation_finding"("runId");

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_finding_runId_dimension_idx" ON "app_questionnaire_evaluation_finding"("runId", "dimension");

-- CreateIndex
CREATE INDEX "app_questionnaire_evaluation_finding_status_idx" ON "app_questionnaire_evaluation_finding"("status");

-- AddForeignKey
ALTER TABLE "app_questionnaire_evaluation_run" ADD CONSTRAINT "app_questionnaire_evaluation_run_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_evaluation_finding" ADD CONSTRAINT "app_questionnaire_evaluation_finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "app_questionnaire_evaluation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
