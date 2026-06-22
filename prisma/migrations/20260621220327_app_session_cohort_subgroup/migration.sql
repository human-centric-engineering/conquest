-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "cohortSubgroupId" TEXT;

-- CreateIndex
CREATE INDEX "app_questionnaire_session_cohortSubgroupId_idx" ON "app_questionnaire_session"("cohortSubgroupId");
