-- F3.4: demo-client invitation branding.
--
-- Adds the AppDemoClient theme columns (ctaColor, accentColor, logoUrl, welcomeCopy
-- — all nullable; resolveTheme() fills nulls with Sunrise defaults) and the
-- demoClientId brand-snapshot FK on AppQuestionnaireInvitation (onDelete SET NULL,
-- indexed).
--
-- Schema-fold strip applied by hand: `prisma migrate dev` re-emitted DROPs of the
-- platform's pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding) and an ALTER of the GENERATED
-- ai_knowledge_chunk."searchVector" column — Prisma-unmodelled objects with no
-- bearing on these app tables. They are removed so this migration is a clean additive
-- ALTER; the schema-guard test asserts they never leak back in.

-- AlterTable
ALTER TABLE "app_demo_client" ADD COLUMN     "accentColor" TEXT,
ADD COLUMN     "ctaColor" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "welcomeCopy" TEXT;

-- AlterTable
ALTER TABLE "app_questionnaire_invitation" ADD COLUMN     "demoClientId" TEXT;

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_demoClientId_idx" ON "app_questionnaire_invitation"("demoClientId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_invitation" ADD CONSTRAINT "app_questionnaire_invitation_demoClientId_fkey" FOREIGN KEY ("demoClientId") REFERENCES "app_demo_client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
