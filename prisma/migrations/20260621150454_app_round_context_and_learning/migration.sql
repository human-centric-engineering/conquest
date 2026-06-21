-- NOTE: Prisma's schema-diff also emitted DROP INDEX for the pgvector ANN/search
-- indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding, idx_app_data_slot_embedding, idx_app_question_slot_embedding)
-- and an `ai_knowledge_chunk.searchVector DROP DEFAULT`. Those are PHANTOM diffs —
-- Prisma can't model the raw-SQL pgvector objects — and were stripped from this
-- migration so applying it doesn't drop live indexes. (See the drift warnings in
-- prisma/schema/app-questionnaire.prisma.)

-- AlterTable
ALTER TABLE "app_questionnaire_round" ADD COLUMN     "contextEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "learningConfig" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "learningEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "app_round_context_entry" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "questionSlotId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_round_context_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_round_learning_digest" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "slotKind" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "respondentCount" INTEGER NOT NULL,
    "divergence" DOUBLE PRECISION,
    "sessionsCovered" INTEGER NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_round_learning_digest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_round_context_entry_roundId_idx" ON "app_round_context_entry"("roundId");

-- CreateIndex
CREATE INDEX "app_round_context_entry_roundId_versionId_questionSlotId_idx" ON "app_round_context_entry"("roundId", "versionId", "questionSlotId");

-- CreateIndex
CREATE INDEX "app_round_learning_digest_roundId_versionId_idx" ON "app_round_learning_digest"("roundId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_round_learning_digest_roundId_versionId_slotKind_slotKe_key" ON "app_round_learning_digest"("roundId", "versionId", "slotKind", "slotKey");

-- AddForeignKey
ALTER TABLE "app_round_context_entry" ADD CONSTRAINT "app_round_context_entry_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "app_questionnaire_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_round_learning_digest" ADD CONSTRAINT "app_round_learning_digest_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "app_questionnaire_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;
