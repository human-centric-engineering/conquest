-- Data Slots feature: the semantic abstraction layer over questions.
-- NOTE: Prisma's schema-diff also emitted phantom DROP INDEX statements for the
-- pgvector/tsvector indexes it cannot model (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_question_slot_embedding) plus
-- an `ALTER COLUMN "searchVector" DROP DEFAULT`. Those were stripped by hand (they would
-- drop live ANN/FTS indexes). See the drift warnings in app-questionnaire.prisma and
-- memory: app-migration-create-only-strip.

-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "sideEffectDataSlotIds" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "app_data_slot" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "generationConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_data_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_data_slot_question" (
    "id" TEXT NOT NULL,
    "dataSlotId" TEXT NOT NULL,
    "questionSlotId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_data_slot_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_data_slot_fill" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "dataSlotId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "paraphrase" TEXT,
    "confidence" DOUBLE PRECISION,
    "provenanceLabel" TEXT NOT NULL DEFAULT 'direct',
    "rationale" TEXT,
    "lastUpdatedTurnId" TEXT,
    "refinementHistory" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_data_slot_fill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_data_slot_versionId_idx" ON "app_data_slot"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_data_slot_versionId_key_key" ON "app_data_slot"("versionId", "key");

-- CreateIndex
CREATE INDEX "app_data_slot_question_dataSlotId_idx" ON "app_data_slot_question"("dataSlotId");

-- CreateIndex
CREATE INDEX "app_data_slot_question_questionSlotId_idx" ON "app_data_slot_question"("questionSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "app_data_slot_question_dataSlotId_questionSlotId_key" ON "app_data_slot_question"("dataSlotId", "questionSlotId");

-- CreateIndex
CREATE INDEX "app_data_slot_fill_sessionId_idx" ON "app_data_slot_fill"("sessionId");

-- CreateIndex
CREATE INDEX "app_data_slot_fill_dataSlotId_idx" ON "app_data_slot_fill"("dataSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "app_data_slot_fill_sessionId_dataSlotId_key" ON "app_data_slot_fill"("sessionId", "dataSlotId");

-- AddForeignKey
ALTER TABLE "app_data_slot" ADD CONSTRAINT "app_data_slot_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_data_slot_question" ADD CONSTRAINT "app_data_slot_question_dataSlotId_fkey" FOREIGN KEY ("dataSlotId") REFERENCES "app_data_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_data_slot_question" ADD CONSTRAINT "app_data_slot_question_questionSlotId_fkey" FOREIGN KEY ("questionSlotId") REFERENCES "app_question_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_data_slot_fill" ADD CONSTRAINT "app_data_slot_fill_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_questionnaire_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_data_slot_fill" ADD CONSTRAINT "app_data_slot_fill_dataSlotId_fkey" FOREIGN KEY ("dataSlotId") REFERENCES "app_data_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
