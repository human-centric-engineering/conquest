-- F4.5 hardening: enforce at most ONE preview session per version.
--
-- F4.4's getOrCreatePreviewSession() is a findFirst-then-create with no DB-level
-- uniqueness, so two concurrent admin requests (refine-answer / complete) for the
-- same version can each miss the lookup and both create a preview session, splitting
-- a version's preview answers across two rows. This partial unique index makes the
-- losing create fail with P2002, which getOrCreatePreviewSession now catches and
-- resolves to the winning row.
--
-- PARTIAL (WHERE "isPreview" = true) on purpose: real respondent sessions (F4.6,
-- isPreview = false) must stay unconstrained — a version has many of those. Prisma
-- cannot model a partial unique index, so it lives here in raw SQL and is guarded by
-- a drift probe (lib/app/db-drift.ts); a future `prisma migrate dev` that emits a
-- phantom DROP for it will fail `npm run db:drift-check` instead of silently
-- reopening the race. This migration was hand-authored (no schema.prisma change) and
-- applied with `migrate deploy` so Prisma never diffs it into a phantom drop.

-- Defensive dedupe before the constraint: if a pre-constraint race already created
-- duplicate preview sessions, keep the earliest per version and drop the extras.
-- Preview sessions are throwaway admin-exercise data (isPreview, excluded from P8
-- analytics) and their AppAnswerSlot rows cascade — discarding duplicates is safe.
DELETE FROM "app_questionnaire_session" s
USING (
  SELECT id,
         row_number() OVER (PARTITION BY "versionId" ORDER BY "createdAt", id) AS rn
  FROM "app_questionnaire_session"
  WHERE "isPreview" = true
) dup
WHERE s.id = dup.id AND dup.rn > 1;

CREATE UNIQUE INDEX "idx_app_questionnaire_session_preview_per_version"
  ON "app_questionnaire_session" ("versionId")
  WHERE "isPreview" = true;
