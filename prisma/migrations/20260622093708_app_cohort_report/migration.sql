-- AlterTable: Cohort Report config block (report kind `cohort`), lazy-defaulted like respondentReport.
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "cohortReport" JSONB NOT NULL DEFAULT '{}';

-- CreateTable: the generated Cohort Report header (1:1 with a round); body lives in revisions (F14.3).
CREATE TABLE "app_cohort_report" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "publishStatus" TEXT NOT NULL DEFAULT 'draft',
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_cohort_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_report_roundId_key" ON "app_cohort_report"("roundId");

-- CreateIndex
CREATE INDEX "app_cohort_report_status_lockedAt_idx" ON "app_cohort_report"("status", "lockedAt");

-- AddForeignKey
ALTER TABLE "app_cohort_report" ADD CONSTRAINT "app_cohort_report_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "app_questionnaire_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;
