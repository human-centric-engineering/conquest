-- F2.2 tagging — app-owned tables only.
--
-- Schema-fold footgun (see .context/app/questionnaire/schema.md): `migrate dev`
-- re-emitted four phantom statements against platform objects Prisma can't model —
-- `DROP INDEX idx_ai_knowledge_chunk_search_vector`, `DROP INDEX idx_knowledge_embedding`,
-- `DROP INDEX idx_message_embedding`, and `ALTER TABLE ai_knowledge_chunk ALTER COLUMN
-- "searchVector" DROP DEFAULT`. The database is correct; the diff is wrong. All four were
-- stripped by hand, leaving only the intended CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY
-- for the two new tag tables. The schema-shape test guards against any of them leaking back in.

-- CreateTable
CREATE TABLE "app_question_tag" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_question_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_question_slot_tag" (
    "id" TEXT NOT NULL,
    "questionSlotId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_question_slot_tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_question_tag_versionId_idx" ON "app_question_tag"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "app_question_tag_versionId_normalizedLabel_key" ON "app_question_tag"("versionId", "normalizedLabel");

-- CreateIndex
CREATE INDEX "app_question_slot_tag_questionSlotId_idx" ON "app_question_slot_tag"("questionSlotId");

-- CreateIndex
CREATE INDEX "app_question_slot_tag_tagId_idx" ON "app_question_slot_tag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "app_question_slot_tag_questionSlotId_tagId_key" ON "app_question_slot_tag"("questionSlotId", "tagId");

-- AddForeignKey
ALTER TABLE "app_question_tag" ADD CONSTRAINT "app_question_tag_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_question_slot_tag" ADD CONSTRAINT "app_question_slot_tag_questionSlotId_fkey" FOREIGN KEY ("questionSlotId") REFERENCES "app_question_slot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_question_slot_tag" ADD CONSTRAINT "app_question_slot_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "app_question_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
