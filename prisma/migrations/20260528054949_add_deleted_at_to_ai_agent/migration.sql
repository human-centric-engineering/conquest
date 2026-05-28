-- AlterTable: add the soft-delete timestamp. Nullable so existing rows
-- remain "not deleted" by default.
ALTER TABLE "ai_agent" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ai_agent_deletedAt_idx" ON "ai_agent"("deletedAt");

-- Backfill 1: rows that already carry the slug tombstone (`-deleted-<id>`
-- suffix written by DELETE since the earlier soft-delete fix). Their delete
-- happened on or after that fix, so use the most recent admin-audit
-- `agent.delete` timestamp when present, otherwise fall back to updatedAt.
UPDATE "ai_agent" AS a
SET "deletedAt" = COALESCE(
  (
    SELECT MAX(l."createdAt")
    FROM "ai_admin_audit_log" l
    WHERE l."entityType" = 'agent'
      AND l.action = 'agent.delete'
      AND l."entityId" = a.id
  ),
  a."updatedAt"
)
WHERE a.slug LIKE '%-deleted-%' AND a."deletedAt" IS NULL;

-- Backfill 2: legacy soft-deletes from before the slug-tombstone fix
-- shipped. These have isActive=false AND a matching `agent.delete` admin
-- audit entry but the slug was never renamed. Tombstone the slug *and*
-- stamp deletedAt so they stop leaking into the admin agents list.
WITH legacy AS (
  SELECT DISTINCT l."entityId" AS id, MAX(l."createdAt") AS deleted_at
  FROM "ai_admin_audit_log" l
  WHERE l."entityType" = 'agent' AND l.action = 'agent.delete'
  GROUP BY l."entityId"
)
UPDATE "ai_agent" AS a
SET
  "deletedAt" = legacy.deleted_at,
  slug = LEFT(a.slug, GREATEST(0, 100 - LENGTH('-deleted-' || a.id)))
         || '-deleted-' || a.id
FROM legacy
WHERE a.id = legacy.id
  AND a."isActive" = false
  AND a."deletedAt" IS NULL
  AND a.slug NOT LIKE '%-deleted-%';
