-- Built-in persona mode on by default, pinned to The Coach, respondents cannot switch.
--
-- personaSelection is either/or against the version's hand-tuned `tone`: enabled = a built-in
-- library persona governs the interviewer. The Coach (neutral-coach) is the balanced default voice.
--
-- Column default only — existing config rows keep their stored value. Note this column previously
-- defaulted to '{}', which narrowPersonaSelection() coerces to enabled:false, so questionnaires
-- created before this migration stay on their own custom tone until an admin opts in.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "personaSelection" SET DEFAULT '{"enabled":true,"defaultPersonaKey":"neutral-coach","allowRespondentSwitch":false,"switcher":"page"}';
