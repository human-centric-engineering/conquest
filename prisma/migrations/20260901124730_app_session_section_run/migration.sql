-- Sectioned interviews (P21): the per-session run state, and the turn's section tag.
--
-- Hand-trimmed, same as the config migration before it: `migrate dev` proposes dropping the five
-- pgvector HNSW indexes and the `searchVector` default on every run, because Prisma cannot model
-- the `Unsupported("vector(1536)")` columns that raw SQL creates them for.
--
-- Both columns are nullable with no backfill, deliberately. Null on `sectionRun` means "not
-- sectioned"; null on `sectionKey` means "this exchange belongs to no section". Every existing row
-- reads correctly as-is, so there is nothing to migrate.
ALTER TABLE "app_questionnaire_session" ADD COLUMN "sectionRun" JSONB;
ALTER TABLE "app_questionnaire_turn" ADD COLUMN "sectionKey" TEXT;
