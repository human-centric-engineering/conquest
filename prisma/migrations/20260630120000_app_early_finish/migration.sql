-- Respondent-controlled early finish (escape hatch). Lets a respondent voluntarily end the session
-- and get their report before the agent's own completion thresholds are met — bypassing the
-- required-question gate. `allowEarlyFinish` turns it on; the two minimums are OR'd to decide when
-- the "Finish up" control unlocks, and a minimum of 0 means "not a criterion on that axis"
-- (both 0 ⇒ available from the start). Config-only (no platform flag), per questionnaire version.
-- AlterTable
ALTER TABLE "app_questionnaire_config"
  ADD COLUMN "allowEarlyFinish" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "earlyFinishMinCoverage" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "earlyFinishMinQuestions" INTEGER NOT NULL DEFAULT 0;
