-- Add lastActiveAt timestamp to AiAgent. Drives the default sort on the
-- admin agents list (after the bespoke-first split). Bumped whenever a
-- conversation is created/updated or a cost log is written against an
-- agent. See lib/orchestration/agents/touch-last-active.ts.
ALTER TABLE "ai_agent" ADD COLUMN "lastActiveAt" TIMESTAMP(3);

-- Index for orderBy efficiency.
CREATE INDEX "ai_agent_lastActiveAt_idx" ON "ai_agent"("lastActiveAt");

-- Backfill: most recent of (any conversation updatedAt, any cost log
-- createdAt) per agent. Agents with neither stay NULL.
UPDATE "ai_agent" a
SET "lastActiveAt" = GREATEST(
  (SELECT MAX("updatedAt") FROM "ai_conversation" WHERE "agentId" = a.id),
  (SELECT MAX("createdAt") FROM "ai_cost_log" WHERE "agentId" = a.id)
);
