-- CreateTable: a versioned deterministic scoring schema (F14.4).
CREATE TABLE "app_scoring_schema" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Scoring',
    "content" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_scoring_schema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_respondent_score" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "schemaId" TEXT NOT NULL,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_respondent_score_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_scoring_schema_versionId_key" ON "app_scoring_schema"("versionId");

-- CreateIndex
CREATE INDEX "app_respondent_score_sessionId_idx" ON "app_respondent_score"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_respondent_score_sessionId_schemaId_key" ON "app_respondent_score"("sessionId", "schemaId");

-- AddForeignKey
ALTER TABLE "app_scoring_schema" ADD CONSTRAINT "app_scoring_schema_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_respondent_score" ADD CONSTRAINT "app_respondent_score_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
