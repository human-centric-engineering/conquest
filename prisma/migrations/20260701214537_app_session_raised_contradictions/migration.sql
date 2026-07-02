-- "Don't nag" ledger: contradictions already surfaced this session, so the per-turn contradiction
-- phase never re-raises the same conflict (RaisedContradiction[] — contradiction/types.ts). PII-free
-- (identity + how it ended only). Defaults to an empty list so existing sessions read as "raised none".
--
-- NOTE: `prisma migrate dev` auto-generated phantom `DROP INDEX` / `ALTER COLUMN ... DROP DEFAULT`
-- statements for the pgvector indexes + tsvector default (they live in raw-SQL migrations Prisma can't
-- see). Those were stripped by hand — this migration only adds the column. See the app-migration notes.
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "raisedContradictions" JSONB NOT NULL DEFAULT '[]';
