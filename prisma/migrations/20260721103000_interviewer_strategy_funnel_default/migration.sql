-- Interviewer strategy on by default: funnel arc, probe for depth, batch related questions.
--
-- Reflect & confirm stays off — it spends a turn restating, and the funnel already re-opens as
-- coverage builds.
--
-- Column default only — existing config rows keep their stored value. Note this column previously
-- defaulted to '{}', which narrowInterviewerStrategy() coerces to all-false, so questionnaires
-- created before this migration keep the built-in questioning prompt until an admin opts in.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "interviewerStrategy" SET DEFAULT '{"enabled":true,"approach":"funnel","probeDepth":true,"reflect":false,"batchRelated":true}';
