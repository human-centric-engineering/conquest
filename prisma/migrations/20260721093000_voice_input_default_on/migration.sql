-- Voice input on by default for new questionnaires.
--
-- The platform feature-flag layer that used to gate this is gone, so voiceEnabled alone governs
-- the mic button. Column default only — existing configs keep the value their admin set.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "voiceEnabled" SET DEFAULT true;
