-- Early-finish default: the "Finish up" control should, by default, only appear once a respondent
-- has effectively completed the questionnaire. Raise the default minimum coverage from 0.5 → 1.0
-- (100%); admins lower it per version to let respondents finish sooner. Existing rows keep their
-- stored value — this only changes the default for config rows created without the column.
--
-- NOTE: Prisma's diff also wanted to DROP the five pgvector indexes and the ai_knowledge_chunk
-- searchVector default (unmodelled objects it can't see). Those DROPs were stripped by hand — see
-- .context/database/schema.md "Migration workflow (and the schema-fold footgun)".
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "earlyFinishMinCoverage" SET DEFAULT 1.0;
