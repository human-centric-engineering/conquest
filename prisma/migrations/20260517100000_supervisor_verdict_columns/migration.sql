-- Supervisor verdict columns on ai_workflow_execution.
--
-- Adds four nullable columns populated by any executor that emits
-- `StepResult.contextPatch`. The `supervisor` step (added in the
-- workflow-supervisor branch) is the first user; future post-hoc
-- audit steps could reuse the same mechanism.
--
-- All columns are nullable. NULL means no supervisor has run on this
-- execution row. Values appear after the first supervisor step
-- completes (in-workflow), or after POST /executions/:id/review is
-- called (retroactive, Phase 4).
--
-- Non-destructive: rows existing prior to this migration get NULL on
-- all four columns and continue to work unchanged. The list view
-- treats NULL as "not yet reviewed".
--
-- Reference: .context/admin/orchestration-provider-audit-guide.md
-- (Supervisor verdict section).

ALTER TABLE "ai_workflow_execution"
  ADD COLUMN IF NOT EXISTS "supervisorVerdict"    TEXT,
  ADD COLUMN IF NOT EXISTS "supervisorScore"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "supervisorReport"     JSONB,
  ADD COLUMN IF NOT EXISTS "supervisorReviewedAt" TIMESTAMP(3);
