-- Presentation mode (P-presentation): flip the per-questionnaire default from "chat" to "both",
-- so new versions offer both the chat and form surfaces (respondent toggles) out of the box.
-- Only the column default changes — existing rows keep whatever the admin set.
-- AlterTable
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "presentationMode" SET DEFAULT 'both';
