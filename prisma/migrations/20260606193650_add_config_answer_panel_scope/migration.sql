-- F7.2 — Answer-slot panel scope.
--
-- Adds the per-version config knob that controls how much of the questionnaire the
-- respondent's live answer panel shows: full_progress (every slot, grouped by
-- section) or answered_only (just captured answers). Defaults to full_progress so
-- an unconfigured version renders the full progress view.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "answerSlotPanelScope" TEXT NOT NULL DEFAULT 'full_progress';
