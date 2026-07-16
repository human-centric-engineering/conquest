-- AlterTable
ALTER TABLE "app_respondent_report" ADD COLUMN     "deliveredRevisionId" TEXT;

-- CreateTable
CREATE TABLE "app_respondent_report_revision" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "content" JSONB,
    "formatted" BOOLEAN NOT NULL DEFAULT false,
    "completionPct" INTEGER,
    "settingsSnapshot" JSONB NOT NULL,
    "instructions" TEXT,
    "authoredBy" TEXT NOT NULL DEFAULT 'admin',
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_respondent_report_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_respondent_report_revision_reportId_idx" ON "app_respondent_report_revision"("reportId");

-- CreateIndex
CREATE INDEX "app_respondent_report_revision_status_lockedAt_idx" ON "app_respondent_report_revision"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_respondent_report_revision_reportId_revisionNumber_key" ON "app_respondent_report_revision"("reportId", "revisionNumber");

-- AddForeignKey
ALTER TABLE "app_respondent_report_revision" ADD CONSTRAINT "app_respondent_report_revision_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "app_respondent_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
