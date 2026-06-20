-- NOTE: phantom pgvector DROP INDEX / searchVector DROP DEFAULT diffs Prisma can't model
-- were stripped from this migration (see the drift warnings in app-questionnaire.prisma).

-- AlterTable
ALTER TABLE "app_questionnaire_invitation" ADD COLUMN     "cohortMemberId" TEXT,
ADD COLUMN     "roundId" TEXT;

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_roundId_idx" ON "app_questionnaire_invitation"("roundId");

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_roundId_cohortMemberId_idx" ON "app_questionnaire_invitation"("roundId", "cohortMemberId");
