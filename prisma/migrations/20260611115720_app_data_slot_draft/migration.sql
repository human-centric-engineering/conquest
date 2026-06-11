-- CreateTable
CREATE TABLE "app_data_slot_draft" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "slots" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_data_slot_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_data_slot_draft_versionId_key" ON "app_data_slot_draft"("versionId");

-- AddForeignKey
ALTER TABLE "app_data_slot_draft" ADD CONSTRAINT "app_data_slot_draft_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
