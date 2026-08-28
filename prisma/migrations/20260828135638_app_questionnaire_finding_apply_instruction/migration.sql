-- The admin's free-text steer for AI-assisted batch apply (F5.4). Nullable: a finding with no
-- instruction applies its structured op deterministically, exactly as before.
ALTER TABLE "app_questionnaire_evaluation_finding" ADD COLUMN     "applyInstruction" TEXT;
