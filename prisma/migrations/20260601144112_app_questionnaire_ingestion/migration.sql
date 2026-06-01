-- ConQuest questionnaire ingestion graph (F1.1 / PR1).
--
-- Hand-trimmed: `prisma migrate dev` also emitted phantom DDL against PLATFORM
-- objects it cannot model and which are NOT part of this change — the pgvector
-- HNSW/GIN indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding) and the GENERATED `searchVector` column on
-- ai_knowledge_chunk. Those DROP/ALTER statements were removed (the searchVector
-- ALTER is also invalid — it is a generated column, which is what made the raw
-- `migrate dev` apply fail mid-script). See
-- .context/app/questionnaire/schema.md and `scripts/db/check-drift.ts`.
-- `npm run db:drift-check` verifies the platform objects survived.

-- AlterTable
ALTER TABLE "app_questionnaire_version" ADD COLUMN     "audience" JSONB,
ADD COLUMN     "goal" TEXT;

-- CreateTable
CREATE TABLE "app_questionnaire_section" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_question_slot" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "guidelines" TEXT,
    "rationale" TEXT,
    "type" TEXT NOT NULL DEFAULT 'free_text',
    "typeConfig" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "extractionConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_question_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_extraction_change" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "targetEntityType" TEXT NOT NULL,
    "targetEntityId" TEXT,
    "sourceQuote" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "rationale" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "revertedAt" TIMESTAMP(3),
    "revertedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_extraction_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_questionnaire_source_document" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mimeType" TEXT,
    "pageCount" INTEGER,
    "warnings" JSONB,
    "extractedText" TEXT NOT NULL,
    "bytes" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_questionnaire_source_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_questionnaire_section_versionId_idx" ON "app_questionnaire_section"("versionId");

-- CreateIndex
CREATE INDEX "app_question_slot_versionId_idx" ON "app_question_slot"("versionId");

-- CreateIndex
CREATE INDEX "app_question_slot_sectionId_idx" ON "app_question_slot"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_question_slot_versionId_key_key" ON "app_question_slot"("versionId", "key");

-- CreateIndex
CREATE INDEX "app_questionnaire_extraction_change_versionId_status_idx" ON "app_questionnaire_extraction_change"("versionId", "status");

-- CreateIndex
CREATE INDEX "app_questionnaire_extraction_change_changeType_idx" ON "app_questionnaire_extraction_change"("changeType");

-- CreateIndex
CREATE INDEX "app_questionnaire_source_document_versionId_idx" ON "app_questionnaire_source_document"("versionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_source_document_fileHash_idx" ON "app_questionnaire_source_document"("fileHash");

-- AddForeignKey
ALTER TABLE "app_questionnaire_section" ADD CONSTRAINT "app_questionnaire_section_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_question_slot" ADD CONSTRAINT "app_question_slot_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "app_questionnaire_section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_extraction_change" ADD CONSTRAINT "app_questionnaire_extraction_change_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_questionnaire_source_document" ADD CONSTRAINT "app_questionnaire_source_document_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
