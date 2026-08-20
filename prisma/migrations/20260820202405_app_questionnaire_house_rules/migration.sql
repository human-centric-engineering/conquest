-- Interviewer house rules: the client-specific behaviour policy for one questionnaire
-- ({ enabled, rules: [{ id, kind, enabled, text, trigger? }] }, narrowed by narrowHouseRules).
-- Empty object default — the read-path narrower supplies { enabled: false, rules: [] }, so every
-- existing version is off and its interviewer prompt is unchanged.
--
-- NOTE: the generator also emitted DROP INDEX statements for the five pgvector indexes and a
-- DROP DEFAULT on ai_knowledge_chunk.searchVector. Those are phantoms — Prisma cannot represent
-- pgvector/tsvector indexes in the schema, so it proposes dropping them on every app migration.
-- They were stripped by hand; applying them would silently destroy the vector search indexes.
ALTER TABLE "app_questionnaire_config" ADD COLUMN "houseRules" JSONB NOT NULL DEFAULT '{}';
