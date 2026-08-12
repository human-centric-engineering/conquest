-- Adaptive Scope (P17): the conditional unit (topic), the Routing Analyst's draft,
-- the version-level settings blob, and the per-session interview plan.
--
-- Purely additive: two new tables, two new columns. No existing table is altered in place,
-- no index is dropped, and nothing touches the pgvector columns/indexes on
-- app_question_slot.embedding or app_data_slot.embedding.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "adaptiveScope" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "interviewPlan" JSONB;

-- CreateTable
CREATE TABLE "app_questionnaire_topic" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'core',
    "criteria" TEXT,
    "depth" TEXT NOT NULL DEFAULT 'full',
    "members" JSONB NOT NULL DEFAULT '{"dataSlotKeys":[],"questionKeys":[]}',
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seeded',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_topic_draft" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "topics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_topic_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_topic_versionId_idx" ON "app_questionnaire_topic"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_topic_versionId_key_key" ON "app_questionnaire_topic"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_topic_draft_versionId_key" ON "app_questionnaire_topic_draft"("versionId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_topic" ADD CONSTRAINT "app_questionnaire_topic_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_topic_draft" ADD CONSTRAINT "app_questionnaire_topic_draft_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

