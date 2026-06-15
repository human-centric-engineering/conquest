-- AlterTable: live "watch it think" reasoning-stream config (demo feature) — per-version toggle,
-- placement (overlay | inline), and whether to persist the trace on each turn.
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "reasoningStreamEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reasoningStreamPersist" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reasoningStreamPlacement" TEXT NOT NULL DEFAULT 'overlay';

-- AlterTable: persisted per-turn reasoning trace (ReasoningStep[]) — replays on resume/scroll-back
-- when config.reasoningStreamPersist is on. Respondent-safe (no abuse/sensitivity content).
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "reasoning" JSONB NOT NULL DEFAULT '[]';
