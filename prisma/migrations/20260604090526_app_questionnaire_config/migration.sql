-- F3.1 — Questionnaire configuration.
--
-- Adds the per-version run-time config table (1:1 with app_questionnaire_version,
-- cascade-on-delete). Lazy: no row until the admin first saves config; the read
-- path resolves an absent row to defaults.
--
-- SCHEMA-FOLD STRIP: `prisma migrate dev` re-emitted DROPs of the platform's three
-- pgvector indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding) and an invalid ALTER of the GENERATED ai_knowledge_chunk
-- "searchVector" column — Prisma can't see those unmodelled objects, so it thinks
-- they drifted. They are stripped here by hand (the same strip every prior
-- app_questionnaire migration applied); the schema-guard test asserts they stay out.

-- CreateTable
CREATE TABLE "app_questionnaire_config" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "selectionStrategy" TEXT NOT NULL DEFAULT 'sequential',
    "minQuestionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "coverageThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "costBudgetUsd" DOUBLE PRECISION,
    "maxQuestionsPerSession" INTEGER,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "contradictionMode" TEXT NOT NULL DEFAULT 'off',
    "contradictionWindowN" INTEGER NOT NULL DEFAULT 0,
    "anonymousMode" BOOLEAN NOT NULL DEFAULT false,
    "profileFields" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_config_versionId_key" ON "app_questionnaire_config"("versionId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_config" ADD CONSTRAINT "app_questionnaire_config_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
