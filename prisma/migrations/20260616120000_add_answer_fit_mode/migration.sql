-- Answer-fit resolver mode: a second, focused free-form → choice/likert mapping pass on the live
-- turn (e.g. "Marketing" → the "Other" option; "10 years" → the "3+ years" bucket).
-- Default 'fallback' matches DEFAULT_QUESTIONNAIRE_CONFIG.answerFitMode (off | fallback | always).

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "answerFitMode" TEXT NOT NULL DEFAULT 'fallback';
