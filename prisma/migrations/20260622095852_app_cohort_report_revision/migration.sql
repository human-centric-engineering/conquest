-- CreateTable: one version-controlled iteration of a Cohort Report's body (F14.3).
CREATE TABLE "app_cohort_report_revision" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "authoredBy" TEXT NOT NULL DEFAULT 'ai',
    "summary" TEXT,
    "costUsd" DOUBLE PRECISION,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_cohort_report_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_cohort_report_revision_reportId_idx" ON "app_cohort_report_revision"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_report_revision_reportId_revisionNumber_key" ON "app_cohort_report_revision"("reportId", "revisionNumber");

-- AddForeignKey
ALTER TABLE "app_cohort_report_revision" ADD CONSTRAINT "app_cohort_report_revision_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "app_cohort_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
