-- Remove the retired ConQuest questionnaire feature flags.
--
-- Every questionnaire feature is now permanently on: the application no longer
-- reads these flags, so the rows are inert. This data-only migration deletes
-- them so they stop cluttering the admin Features page in every environment
-- (it runs automatically on `prisma migrate deploy`).
--
-- Scoped precisely to the retired keys — it cannot touch MAINTENANCE_MODE (no
-- APP_ prefix) or any other flag. Idempotent: a no-op once the rows are gone.
DELETE FROM "feature_flag"
WHERE "name" LIKE 'APP\_QUESTIONNAIRES\_%' ESCAPE '\'
   OR "name" = 'APP_REPORT_FORMATTER_ENABLED';
