-- AppCohortReport: polymorphic owner (round | version).
--
-- Generalises the round-only cohort report to also own a version-wide (cross-round) synthesis. A
-- report's owner is now `scopeKind` ('round' | 'version') with two nullable-unique owner keys:
--   * roundId        — already UNIQUE; now nullable so version-scope rows leave it NULL. Postgres
--                      allows multiple NULLs in a unique index, so the round 1:1 + FK/cascade stay
--                      intact while version rows coexist.
--   * versionOwnerId — new nullable-unique key (= versionId) enforcing one version-wide report per
--                      version; NULL for round-scope rows.
--
-- No backfill: existing rows are round-scoped, and `scopeKind DEFAULT 'round'` + `versionOwnerId`
-- defaulting to NULL classify them correctly. The existing app_cohort_report_roundId_key unique
-- index is preserved (dropping NOT NULL does not drop it).
--
-- (Phantom DROP INDEX/ALTER lines for the unmodelled pgvector + tsvector objects that
-- `prisma migrate diff` emits — search_vector generated column and the HNSW/GIN indexes — are
-- intentionally omitted; Prisma doesn't model them, so it must not drop them.)

-- AlterTable
ALTER TABLE "app_cohort_report" ADD COLUMN     "scopeKind" TEXT NOT NULL DEFAULT 'round',
ADD COLUMN     "versionOwnerId" TEXT,
ALTER COLUMN "roundId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_report_versionOwnerId_key" ON "app_cohort_report"("versionOwnerId");

-- CreateIndex
CREATE INDEX "app_cohort_report_versionId_idx" ON "app_cohort_report"("versionId");
