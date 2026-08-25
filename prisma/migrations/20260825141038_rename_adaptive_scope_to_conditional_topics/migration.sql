-- Adaptive Scope was renamed to Conditional Topics.
--
-- Both are plain column renames: every existing row keeps its value, so a version that had
-- Conditional Topics configured under the old name stays configured, and one that never opted in
-- stays off. No data is read, rewritten or defaulted here — which is why no back-compat read shim
-- is needed anywhere in the application code.
--
-- Columns are unquoted-camelCase in this schema (no `@map`), hence the quoted identifiers.

ALTER TABLE "app_questionnaire_config" RENAME COLUMN "adaptiveScope" TO "conditionalTopics";

ALTER TABLE "app_questionnaire_version" RENAME COLUMN "adaptiveScopeCandidate" TO "conditionalTopicsCandidate";
