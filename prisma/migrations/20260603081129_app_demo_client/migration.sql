-- F2.5.1 — Demo-client foundation: AppDemoClient identity table + nullable
-- demoClientId FK on AppQuestionnaire (onDelete: SetNull).
--
-- STRIPPED (schema-fold footgun — see .context/app/questionnaire/schema.md §
-- "Migration workflow"): `migrate dev` re-emitted the standard A-series phantom
-- DDL against Prisma-unmodelled platform objects — `DROP INDEX` of the three
-- pgvector indexes (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
-- idx_message_embedding) and `ALTER "ai_knowledge_chunk"."searchVector" DROP
-- DEFAULT`. The database is correct; the diff is wrong. Removed by hand, leaving
-- only the intended app DDL below. db:drift-check green.

-- AlterTable
ALTER TABLE "app_questionnaire" ADD COLUMN     "demoClientId" TEXT;

-- CreateTable
CREATE TABLE "app_demo_client" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_demo_client_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_demo_client_slug_key" ON "app_demo_client"("slug");

-- CreateIndex
CREATE INDEX "app_questionnaire_demoClientId_idx" ON "app_questionnaire"("demoClientId");

-- AddForeignKey
ALTER TABLE "app_questionnaire" ADD CONSTRAINT "app_questionnaire_demoClientId_fkey" FOREIGN KEY ("demoClientId") REFERENCES "app_demo_client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
