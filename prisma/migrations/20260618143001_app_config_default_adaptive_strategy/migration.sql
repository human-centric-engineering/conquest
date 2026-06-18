-- Make `adaptive` the default question-selection strategy for new questionnaire config rows.
-- (App-level default is mirrored in DEFAULT_QUESTIONNAIRE_CONFIG / lib/app/questionnaire/types.ts.)
-- NOTE: Prisma's diff also emitted phantom DROP INDEX / DROP DEFAULT statements for the pgvector
-- embedding indexes and the tsvector searchVector column (platform DDL it doesn't model). Those are
-- intentionally stripped here so this migration only changes the column default. See
-- .claude memory "app-migration-create-only-strip".

-- AlterTable
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "selectionStrategy" SET DEFAULT 'adaptive';
