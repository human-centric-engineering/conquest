-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "promptTokens" INTEGER;

-- CreateTable
CREATE TABLE "app_questionnaire_error" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sessionId" TEXT,
    "invitationId" TEXT,
    "turnOrdinal" INTEGER,
    "scope" TEXT NOT NULL,
    "stage" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'error',
    "code" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_error_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_error_versionId_createdAt_idx" ON "app_questionnaire_error"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "app_questionnaire_error_invitationId_idx" ON "app_questionnaire_error"("invitationId");

-- CreateIndex
CREATE INDEX "app_questionnaire_error_sessionId_idx" ON "app_questionnaire_error"("sessionId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_error" ADD CONSTRAINT "app_questionnaire_error_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
