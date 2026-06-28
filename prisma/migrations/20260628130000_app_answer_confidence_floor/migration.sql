-- Confirmation floor for opportunistic fills (Data Slots feature). An answer scored below this
-- confidence is "tentative" — it does not count toward completion coverage or satisfy a required
-- question until corroborated above it. 0.5 gates the agent's opportunistic guesses (capped at 0.45)
-- without holding back genuine answers. Per-questionnaire; admins can raise it for stricter sign-off.
-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN "answerConfidenceFloor" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
