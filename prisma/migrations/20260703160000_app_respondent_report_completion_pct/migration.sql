-- AlterTable: record the questionnaire completion % at report generation (answered/total slots).
-- Drives the partial-report caveat (rendered below PARTIAL_REPORT_THRESHOLD_PCT). Null for every
-- pre-existing row — those carry no caveat.
--
-- NOTE: hand-authored to contain ONLY the intended column add — Prisma's diff would also emit the
-- phantom pgvector DROP INDEX / searchVector DROP DEFAULT statements (objects that live outside the
-- Prisma-managed schema); applying them drops the 5 platform vector indexes. See .claude memory
-- "migrate dev really drops pgvector indexes".
ALTER TABLE "app_respondent_report" ADD COLUMN "completionPct" INTEGER;
