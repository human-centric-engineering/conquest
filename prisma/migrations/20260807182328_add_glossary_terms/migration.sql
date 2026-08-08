-- Definitions / glossary (P16): curated terms + their candidate definitions, and the optional
-- authoritative definitions document. All three cascade from app_questionnaire_version.
--
-- NOTE: `prisma migrate dev` emitted phantom DDL ahead of this block — DROP INDEX on the five
-- pgvector/tsvector indexes (idx_knowledge_embedding, idx_message_embedding,
-- idx_ai_knowledge_chunk_search_vector, idx_app_question_slot_embedding,
-- idx_app_data_slot_embedding) and a DROP DEFAULT on ai_knowledge_chunk.searchVector. Those
-- objects are managed by raw SQL that Prisma's differ cannot see, so it proposes dropping them on
-- every diff run. They were removed by hand. Do not reinstate them.

-- CreateTable
CREATE TABLE "app_glossary_term" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "normalizedTerm" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "source" TEXT NOT NULL DEFAULT 'ai_proposed',
    "rationale" TEXT,
    "contextQuote" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_glossary_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_glossary_definition" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'ai_proposed',
    "sourceQuote" TEXT,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_glossary_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_glossary_document" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mimeType" TEXT,
    "extractedText" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_glossary_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_glossary_term_versionId_status_idx" ON "app_glossary_term"("versionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "app_glossary_term_versionId_normalizedTerm_key" ON "app_glossary_term"("versionId", "normalizedTerm");

-- CreateIndex
CREATE INDEX "app_glossary_definition_termId_idx" ON "app_glossary_definition"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "app_glossary_document_versionId_key" ON "app_glossary_document"("versionId");

-- CreateIndex
CREATE INDEX "app_glossary_document_fileHash_idx" ON "app_glossary_document"("fileHash");

-- AddForeignKey
ALTER TABLE "app_glossary_term" ADD CONSTRAINT "app_glossary_term_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_glossary_definition" ADD CONSTRAINT "app_glossary_definition_termId_fkey" FOREIGN KEY ("termId") REFERENCES "app_glossary_term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_glossary_document" ADD CONSTRAINT "app_glossary_document_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
