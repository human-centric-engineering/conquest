-- Data Slots feature: provisional fills + per-slot re-ask/park tracking + configurable attempts.
-- (Phantom pgvector DROP INDEX / searchVector DDL that `migrate dev` emits was stripped — those
-- platform indexes are managed by raw-SQL migrations, not Prisma. See project migration convention.)

-- AlterTable
ALTER TABLE "app_data_slot_fill" ADD COLUMN     "provisional" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "maxDataSlotAttempts" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "targetedDataSlotId" TEXT;
