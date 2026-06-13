-- Sensitivity awareness / safeguarding: per-questionnaire opt-in + support copy, and per-session
-- remembered disclosures (running-max level + careful, non-graphic notes).
-- (Phantom pgvector DROP INDEX / searchVector DROP DEFAULT DDL that `migrate dev` emits was
-- stripped — those platform indexes are managed by raw-SQL migrations, not Prisma. See the
-- project migration convention in .context/app/questionnaire/schema.md.)

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "sensitivityAwareness" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supportMessage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "supportResourceUrl" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "sensitivityLevel" TEXT,
ADD COLUMN     "sensitivityNotes" JSONB NOT NULL DEFAULT '[]';
