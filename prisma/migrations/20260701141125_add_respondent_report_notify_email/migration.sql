-- AlterTable: respondent opt-in email for a report-ready notification (WS2).
-- NOTE: Prisma's diff also emitted phantom pgvector DROP INDEX / searchVector DROP DEFAULT
-- statements (the vector indexes + generated-column default live outside the Prisma-managed
-- schema). Those were stripped by hand — applying them drops the 5 platform vector indexes.
-- See .claude memory "migrate dev really drops pgvector indexes".
ALTER TABLE "app_respondent_report" ADD COLUMN "notifyEmail" TEXT;
