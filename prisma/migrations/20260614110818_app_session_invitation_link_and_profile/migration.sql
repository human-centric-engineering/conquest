-- Session ↔ invitation linkage (frictionless token flow) + per-invitee captured profile.
--
-- (Prisma's diff also wanted to DROP the pgvector / tsvector indexes it can't model and drop the
-- searchVector generated default — phantom DDL, stripped. These additions are purely additive.)

-- Per-invitee captured detail fields (InviteeProfile JSON), per config.inviteeFields.
ALTER TABLE "app_questionnaire_invitation" ADD COLUMN     "profile" JSONB;

-- The invitation a session was booted from (frictionless token flow); null for walk-up/public/authed.
-- Read ONLY for per-invitee status — never joined to answer content under anonymousMode.
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "invitationId" TEXT;
CREATE INDEX "app_questionnaire_session_invitationId_idx" ON "app_questionnaire_session"("invitationId");
