-- Per-turn side-band warnings: persist the seriousness / support / contradiction notices a turn
-- surfaced so the respondent surface can replay them inline beneath the turn on resume (previously
-- transient, lost on the next input / a reload).
--
-- (Prisma's diff also wanted to DROP the pgvector / tsvector indexes it can't model and drop the
-- searchVector generated default — phantom DDL, stripped. This migration only adds the column.)

-- AlterTable: additive JSON column, default empty array (matches the `@default("[]")` siblings).
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "warnings" JSONB NOT NULL DEFAULT '[]';
