-- Per-version soft-archive marker (orthogonal to `status`). Mirrors
-- app_questionnaire.archivedAt. Non-null = archived (hidden from the default admin
-- version list, restorable). See .context/app/questionnaire/archiving.md.
--
-- NOTE: `prisma migrate dev` also generated phantom `DROP INDEX` lines for the
-- pgvector/tsvector objects (idx_*_embedding, idx_ai_knowledge_chunk_search_vector)
-- and a `searchVector DROP DEFAULT` — Prisma can't model those raw-SQL objects, so it
-- tries to drop them on every schema diff. Those lines were stripped; this migration
-- adds ONLY the new column + its index.

-- AlterTable
ALTER TABLE "app_questionnaire_version" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "app_questionnaire_version_archivedAt_idx" ON "app_questionnaire_version"("archivedAt");
