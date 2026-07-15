-- AlterTable: how the admin-authored profile fields are collected from the respondent.
-- form = a blocking form gate that rides the carousel after the intro and before the chat;
-- conversational = the interviewer gathers them in-chat. Default form so existing versions keep
-- the up-front form behaviour. (CAPTURE_MODES — lib/app/questionnaire/types.ts)
--
-- NOTE: hand-authored to contain ONLY the intended column add — Prisma's diff would also emit the
-- phantom pgvector DROP INDEX / searchVector DROP DEFAULT statements (objects that live outside the
-- Prisma-managed schema); applying them drops the 5 platform vector indexes. See .claude memory
-- "migrate dev really drops pgvector indexes".
ALTER TABLE "app_questionnaire_config" ADD COLUMN "captureMode" TEXT NOT NULL DEFAULT 'form';
