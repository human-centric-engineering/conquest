-- Inline answer correction (Variant B): per-questionnaire toggle for the inline "fix this answer"
-- gesture. On by default; respondent-facing UX with no platform flag.
-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "inlineCorrectionEnabled" BOOLEAN NOT NULL DEFAULT true;
