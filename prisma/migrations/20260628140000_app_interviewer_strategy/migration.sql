-- Interviewer strategy (questioning approach). A Json config block { enabled, approach, probeDepth,
-- reflect, batchRelated } that, when enabled, overrides the default open-invitation questioning prompt
-- with the chosen openness arc (funnel / open / targeted) plus additive tactics. Off by default ("{}"
-- narrows to disabled), so existing questionnaires are unchanged.
-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN "interviewerStrategy" JSONB NOT NULL DEFAULT '{}';
