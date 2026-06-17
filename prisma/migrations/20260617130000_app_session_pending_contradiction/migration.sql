-- Probe-confirm contradiction flow: hold a detected (probe-mode) contradiction across two turns so
-- the interviewer asks a reconciliation question BEFORE any answer/data-slot is overwritten, and the
-- change is applied only once the respondent confirms it on the following turn.
--
-- Hand-authored (single ADD COLUMN) so `prisma migrate dev` does NOT also emit its phantom DROP of
-- the raw-SQL partial unique index idx_app_questionnaire_session_preview_per_version (Prisma can't
-- model partial uniques, so it tries to drop it on every diff). See the drift note on
-- AppQuestionnaireSession.

ALTER TABLE "app_questionnaire_session" ADD COLUMN "pendingContradiction" JSONB;
