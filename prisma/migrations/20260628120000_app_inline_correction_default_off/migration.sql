-- Inline answer correction (Variant B): flip the per-questionnaire toggle to OFF by default.
-- Only the column default changes — existing rows keep whatever the admin set; this governs
-- new questionnaire configs going forward. Respondent-facing UX with no platform flag.
-- AlterTable
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "inlineCorrectionEnabled" SET DEFAULT false;
