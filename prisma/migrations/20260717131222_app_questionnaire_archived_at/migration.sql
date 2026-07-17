-- Soft-delete / archive dimension for questionnaires. Non-null `archivedAt` hides
-- the questionnaire from the default admin list while keeping it fully recoverable
-- (Restore nulls it). Orthogonal to `status`. Indexed — the list query filters on
-- it every page load. See .context/app/questionnaire/archiving.md.
--
-- NOTE: the phantom pgvector DROP INDEX / DROP DEFAULT statements Prisma emits for
-- the unmodelled vector indexes were stripped by hand (they would drop the 5 vector
-- indexes). See memory: app-migration-create-only-strip.

-- AlterTable
ALTER TABLE "app_questionnaire" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "app_questionnaire_archivedAt_idx" ON "app_questionnaire"("archivedAt");
