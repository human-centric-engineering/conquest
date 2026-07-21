-- Data-slot probing depth: default one attempt, not two.
--
-- A single targeted ask per slot keeps conversations short; the re-ask was rarely earning its
-- extra turn. Column default only — existing configs keep whatever value their admin set (or the
-- old 2 they were created with), so no behaviour shifts under anyone mid-flight.

ALTER TABLE "app_questionnaire_config" ALTER COLUMN "maxDataSlotAttempts" SET DEFAULT 1;
