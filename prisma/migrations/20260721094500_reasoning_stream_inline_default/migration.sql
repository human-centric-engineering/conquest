-- Reasoning stream renders inline by default, not as an overlay.
--
-- Inline is the quieter read: the trace sits under each turn instead of covering the chat.
-- Column default only — existing configs keep the placement their admin set.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "reasoningStreamPlacement" SET DEFAULT 'inline';
