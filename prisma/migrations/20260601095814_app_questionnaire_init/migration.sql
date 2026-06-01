-- ConQuest questionnaire anchor schema (F0.1 / T0.1.3).
--
-- Hand-trimmed: `prisma migrate dev` also emitted DROP/ALTER/RENAME statements
-- against PLATFORM objects it cannot model (the pgvector GIN/HNSW indexes, the
-- GENERATED `searchVector` column, and a pre-existing index-name drift). Those
-- are not part of this change and were removed — see
-- .context/app/questionnaire/schema.md and `scripts/db/check-drift.ts`.
-- `npm run db:drift-check` verifies the platform objects survived.

-- CreateTable
CREATE TABLE "app_questionnaire" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_version" (
    "id" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_status_idx" ON "app_questionnaire"("status");

-- CreateIndex
CREATE INDEX "app_questionnaire_version_questionnaireId_idx" ON "app_questionnaire_version"("questionnaireId");

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_version_questionnaireId_versionNumber_key" ON "app_questionnaire_version"("questionnaireId", "versionNumber");

-- AddForeignKey
ALTER TABLE "app_questionnaire_version" ADD CONSTRAINT "app_questionnaire_version_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "app_questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
