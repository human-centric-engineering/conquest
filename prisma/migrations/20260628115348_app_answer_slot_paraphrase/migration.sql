-- Free-text comment fields: a living, panel-facing paraphrase of the respondent's account
-- (significant verbatim in quotes), distinct from the raw `value`. Null for typed answers and
-- respondent-typed form answers.
--
-- NOTE: `prisma migrate dev` re-emitted phantom pgvector `DROP INDEX` / `searchVector DROP DEFAULT`
-- statements (the introspector can't see the raw-SQL vector indexes). Those were stripped — this
-- migration only adds the column. See the project migration runbook.
ALTER TABLE "app_answer_slot" ADD COLUMN     "paraphrase" TEXT;
