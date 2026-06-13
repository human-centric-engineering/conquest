-- Seriousness / abuse gate: a per-questionnaire tolerance + a per-session strike counter.
-- abuseThreshold = non-genuine answers tolerated before the session is abandoned (default 4;
-- 0 = off). abuseStrikes = cumulative flagged-answer count on a session.
--
-- NB: prisma migrate diff re-emits phantom DROP INDEX / DROP DEFAULT for the pgvector search
-- indexes (Prisma can't model them); those were stripped. See the app-migration create-only note.
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "abuseThreshold" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "app_questionnaire_session" ADD COLUMN     "abuseStrikes" INTEGER NOT NULL DEFAULT 0;
