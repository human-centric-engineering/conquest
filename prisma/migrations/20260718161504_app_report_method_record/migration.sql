-- Method record: the observed account of how one report run was produced (ReportMethodRecord in
-- lib/app/questionnaire/report/method-record.ts). Nullable with no backfill — reports generated before
-- this shipped have no record, and the read path treats null as "don't offer the explanation" rather
-- than reconstructing a run nobody observed.
--
-- NOTE: `prisma migrate dev` also generated DROP INDEX statements for the five pgvector indexes and a
-- DROP DEFAULT on ai_knowledge_chunk.searchVector. Those are phantom diffs — Prisma cannot represent
-- pgvector index types or the generated tsvector default in the schema, so it proposes dropping them on
-- every app migration. They have been stripped deliberately; do not reinstate them.

-- AlterTable
ALTER TABLE "app_respondent_report" ADD COLUMN     "methodRecord" JSONB;

-- AlterTable
ALTER TABLE "app_respondent_report_revision" ADD COLUMN     "methodRecord" JSONB;
