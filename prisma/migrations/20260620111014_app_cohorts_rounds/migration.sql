-- NOTE: Prisma's schema-diff also emitted DROP INDEX for the pgvector ANN/search
-- indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding, idx_app_data_slot_embedding, idx_app_question_slot_embedding)
-- and an `ai_knowledge_chunk.searchVector DROP DEFAULT`. Those are PHANTOM diffs —
-- Prisma can't model the raw-SQL pgvector objects — and were stripped from this
-- migration so applying it doesn't drop live indexes. (See the drift warnings in
-- prisma/schema/app-questionnaire.prisma.)

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "cohortMemberId" TEXT,
ADD COLUMN     "roundId" TEXT;

-- CreateTable
CREATE TABLE "app_cohort" (
    "id" TEXT NOT NULL,
    "demoClientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_cohort_member" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_cohort_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_round" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_round_item" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "versionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_round_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_cohort_demoClientId_idx" ON "app_cohort"("demoClientId");

-- CreateIndex
CREATE INDEX "app_cohort_member_cohortId_idx" ON "app_cohort_member"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_member_cohortId_email_key" ON "app_cohort_member"("cohortId", "email");

-- CreateIndex
CREATE INDEX "app_questionnaire_round_cohortId_idx" ON "app_questionnaire_round"("cohortId");

-- CreateIndex
CREATE INDEX "app_questionnaire_round_status_idx" ON "app_questionnaire_round"("status");

-- CreateIndex
CREATE INDEX "app_questionnaire_round_item_roundId_idx" ON "app_questionnaire_round_item"("roundId");

-- CreateIndex
CREATE INDEX "app_questionnaire_round_item_questionnaireId_idx" ON "app_questionnaire_round_item"("questionnaireId");

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_round_item_roundId_questionnaireId_key" ON "app_questionnaire_round_item"("roundId", "questionnaireId");

-- CreateIndex
CREATE INDEX "app_questionnaire_session_roundId_idx" ON "app_questionnaire_session"("roundId");

-- CreateIndex
CREATE INDEX "app_questionnaire_session_cohortMemberId_idx" ON "app_questionnaire_session"("cohortMemberId");

-- AddForeignKey
ALTER TABLE "app_cohort" ADD CONSTRAINT "app_cohort_demoClientId_fkey" FOREIGN KEY ("demoClientId") REFERENCES "app_demo_client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_cohort_member" ADD CONSTRAINT "app_cohort_member_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "app_cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_round" ADD CONSTRAINT "app_questionnaire_round_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "app_cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_round_item" ADD CONSTRAINT "app_questionnaire_round_item_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "app_questionnaire_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_round_item" ADD CONSTRAINT "app_questionnaire_round_item_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "app_questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
