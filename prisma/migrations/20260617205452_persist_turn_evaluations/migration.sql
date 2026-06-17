-- CreateTable
CREATE TABLE "app_questionnaire_turn_evaluation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "turnOrdinal" INTEGER NOT NULL,
    "verdict" JSONB NOT NULL,
    "evaluatedInput" JSONB NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "effectiveness" TEXT NOT NULL,
    "evaluatorAgentId" TEXT,
    "evaluatorModel" TEXT NOT NULL,
    "evaluatorProvider" TEXT NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "questionnaireVersionId" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION,
    "evaluatedByUserId" TEXT,
    "comment" TEXT,
    "commentByUserId" TEXT,
    "commentAt" TIMESTAMP(3),
    "flagStatus" TEXT NOT NULL DEFAULT 'none',
    "flagReviewerId" TEXT,
    "flagUpdatedAt" TIMESTAMP(3),
    "datasetId" TEXT,
    "datasetCaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_turn_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_evaluation_sessionId_idx" ON "app_questionnaire_turn_evaluation"("sessionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_evaluation_questionnaireVersionId_cr_idx" ON "app_questionnaire_turn_evaluation"("questionnaireVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_evaluation_flagStatus_createdAt_idx" ON "app_questionnaire_turn_evaluation"("flagStatus", "createdAt");

-- CreateIndex
CREATE INDEX "app_questionnaire_turn_evaluation_overallScore_idx" ON "app_questionnaire_turn_evaluation"("overallScore");

-- AddForeignKey
ALTER TABLE "app_questionnaire_turn_evaluation" ADD CONSTRAINT "app_questionnaire_turn_evaluation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
