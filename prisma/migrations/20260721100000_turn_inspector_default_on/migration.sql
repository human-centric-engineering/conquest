-- Preview Turn Inspector on by default.
--
-- Safe to default on: the server gates it to preview sessions (AppQuestionnaireSession.isPreview),
-- so it is never reachable by a real respondent regardless of this value.
-- Column default only — existing configs keep the value their admin set.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "previewInspectorEnabled" SET DEFAULT true;
