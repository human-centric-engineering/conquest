-- A topic can now record what the INSTRUMENT said to watch for during the conversation, when the
-- document asks for it to be added on something that surfaces rather than on how the opening went.
--
-- `{ condition: string, cues: string[], sourceQuote?: string }` — TopicTrigger (scope/types.ts).
--
-- Nullable with no default and no backfill: absent is the correct value for every existing topic
-- and for every topic an author scopes from the opening, which is nearly all of them. Nothing reads
-- this at interview time — scope is still settled once, when the opening completes — so applying it
-- changes no respondent's experience.
ALTER TABLE "app_questionnaire_topic" ADD COLUMN "trigger" JSONB;
