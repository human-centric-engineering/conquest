-- Agent profile library + agent-level inheritance fields.
--
-- A profile is a reusable bundle of persona / brand-voice / guardrails
-- text. Agents optionally point at one profile via `ai_agent.profileId`.
-- For each of the three inheritable fields the agent stores its own
-- text plus a mode column (`personaMode`, `voiceMode`, `guardrailsMode`)
-- with values "override" | "append" — see
-- lib/orchestration/agents/resolve-effective-prompt.ts for the rules.
--
-- Non-destructive. All new columns default to NULL (text) or 'override'
-- (mode), so existing agents behave exactly as today until an operator
-- opts them into a profile.
--
-- Reference: .context/admin/orchestration-agent-profiles.md
--          : .context/orchestration/agent-profiles.md

CREATE TABLE "ai_agent_profile" (
  "id"                     TEXT NOT NULL,
  "name"                   TEXT NOT NULL,
  "slug"                   TEXT NOT NULL,
  "description"            TEXT,
  "persona"                TEXT,
  "brandVoiceInstructions" TEXT,
  "guardrails"             TEXT,
  "isSystem"               BOOLEAN NOT NULL DEFAULT false,
  "createdBy"              TEXT NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_agent_profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agent_profile_slug_key"
  ON "ai_agent_profile" ("slug");

CREATE INDEX "ai_agent_profile_createdBy_idx"
  ON "ai_agent_profile" ("createdBy");

ALTER TABLE "ai_agent_profile"
  ADD CONSTRAINT "ai_agent_profile_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_agent"
  ADD COLUMN IF NOT EXISTS "persona"        TEXT,
  ADD COLUMN IF NOT EXISTS "guardrails"     TEXT,
  ADD COLUMN IF NOT EXISTS "personaMode"    TEXT NOT NULL DEFAULT 'override',
  ADD COLUMN IF NOT EXISTS "voiceMode"      TEXT NOT NULL DEFAULT 'override',
  ADD COLUMN IF NOT EXISTS "guardrailsMode" TEXT NOT NULL DEFAULT 'override',
  ADD COLUMN IF NOT EXISTS "profileId"      TEXT;

CREATE INDEX IF NOT EXISTS "ai_agent_profileId_idx"
  ON "ai_agent" ("profileId");

ALTER TABLE "ai_agent"
  ADD CONSTRAINT "ai_agent_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ai_agent_profile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
