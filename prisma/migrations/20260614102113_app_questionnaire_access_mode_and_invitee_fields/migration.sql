-- Access mode (who may start — orthogonal to anonymousMode) + admin-configurable invitee fields.
--
-- (Prisma's diff also wanted to DROP the pgvector / tsvector indexes it can't model and drop the
-- searchVector generated default — phantom DDL, stripped. This migration only adds the two config
-- columns and backfills accessMode from the historical anonymousMode conflation.)

-- AlterTable: new config columns (defaults match DEFAULT_QUESTIONNAIRE_CONFIG / DEFAULT_INVITEE_FIELDS).
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "accessMode" TEXT NOT NULL DEFAULT 'invitation_only',
ADD COLUMN     "inviteeFields" JSONB NOT NULL DEFAULT '[{"key":"firstName","shown":true,"required":false},{"key":"surname","shown":true,"required":false},{"key":"email","shown":true,"required":true},{"key":"jobTitle","shown":false,"required":false},{"key":"team","shown":false,"required":false},{"key":"organisation","shown":false,"required":false}]';

-- Backfill: historically `anonymousMode = true` meant "public link, anyone can answer". Preserve
-- that access behaviour under the new axis; anonymousMode stays as the identity axis.
UPDATE "app_questionnaire_config" SET "accessMode" = CASE WHEN "anonymousMode" = true THEN 'public' ELSE 'invitation_only' END;
