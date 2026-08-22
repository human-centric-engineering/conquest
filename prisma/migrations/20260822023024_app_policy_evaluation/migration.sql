-- The interviewer-policy judge panel (F18.8): one run row, one row per finding. The third pair of
-- its kind, after the design-evaluation (F5.2) and scope-evaluation (F17.21) tables.
--
-- NOTE: `prisma migrate dev` also generates DROP INDEX statements for the five pgvector/tsvector
-- indexes (created by raw SQL the Prisma schema cannot express) and a DROP DEFAULT on
-- ai_knowledge_chunk.searchVector. Those are phantom diffs and have been stripped by hand.

-- CreateTable
CREATE TABLE "app_questionnaire_policy_evaluation_run" (
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
    "policySnapshot" JSONB,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_policy_evaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_policy_evaluation_finding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "targetKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "proposedChange" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "sourceQuote" TEXT,
    "proposedEdit" JSONB,
    "editedOverride" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "appliedToVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_policy_evaluation_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_run_versionId_createdAt_idx" ON "app_questionnaire_policy_evaluation_run"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_run_questionnaireId_idx" ON "app_questionnaire_policy_evaluation_run"("questionnaireId");

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_run_status_idx" ON "app_questionnaire_policy_evaluation_run"("status");

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_finding_runId_idx" ON "app_questionnaire_policy_evaluation_finding"("runId");

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_finding_runId_dimension_idx" ON "app_questionnaire_policy_evaluation_finding"("runId", "dimension");

-- CreateIndex
CREATE INDEX "app_questionnaire_policy_evaluation_finding_status_idx" ON "app_questionnaire_policy_evaluation_finding"("status");

-- AddForeignKey
ALTER TABLE "app_questionnaire_policy_evaluation_run" ADD CONSTRAINT "app_questionnaire_policy_evaluation_run_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_policy_evaluation_finding" ADD CONSTRAINT "app_questionnaire_policy_evaluation_finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "app_questionnaire_policy_evaluation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
