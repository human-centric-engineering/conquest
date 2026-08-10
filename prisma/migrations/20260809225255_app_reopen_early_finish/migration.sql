-- Reopen-after-early-report (F-early-finish-reopen). Two changes, bundled since both landed in the
-- same schema edit pass:
--
-- 1. Flip the early-finish escape hatch's default from off -> on. The new "Continue answering"
--    reopen feature (lib/app/questionnaire/session/reopen-logic.ts) is what makes defaulting-on
--    safe: a respondent who finishes early is no longer permanently locked out of the rest of the
--    questionnaire. Existing rows keep their stored value — this only changes the default applied
--    to config rows created/saved without the column.
-- 2. Add a monotonic `generation` fence to AppRespondentReport so a stale in-flight report from a
--    respondent's FIRST early finish can't clobber the fresh one generated after they reopen and
--    finish again — see the worker's terminal-write guards in lib/app/questionnaire/report/worker.ts.
--
-- NOTE: Prisma's diff also wanted to DROP the five pgvector indexes and the ai_knowledge_chunk
-- searchVector default (unmodelled objects it can't see). Those DROPs were stripped by hand — see
-- .context/database/schema.md "Migration workflow (and the schema-fold footgun)".
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "allowEarlyFinish" SET DEFAULT true;

ALTER TABLE "app_respondent_report" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
