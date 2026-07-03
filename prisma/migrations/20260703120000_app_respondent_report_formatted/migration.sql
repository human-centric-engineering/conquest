-- AlterTable: mark whether the Report Formatter second pass laid out the stored report prose.
-- When true, the renderers honour the formatter's paragraphs/bullets verbatim; when false (the
-- default, and every pre-existing row) they apply the deterministic `splitReportParagraphs` split.
--
-- NOTE: Prisma's diff would also emit phantom pgvector DROP INDEX / searchVector DROP DEFAULT
-- statements (the vector indexes + generated-column default live outside the Prisma-managed schema).
-- This migration is hand-authored to contain ONLY the intended column add — applying the phantom
-- statements drops the 5 platform vector indexes. See .claude memory
-- "migrate dev really drops pgvector indexes".
ALTER TABLE "app_respondent_report" ADD COLUMN "formatted" BOOLEAN NOT NULL DEFAULT false;
