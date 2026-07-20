-- Experiences (F15.5b): rooms within a breakout.
--
-- A breakout is a period of TIME, and usually the whole group answers the same questionnaire
-- individually with no rooms at all. Rooms are the optional refinement: the group splits, each room
-- takes its own dedicated questionnaire, and works either individually or through one person
-- writing for everybody.
--
-- A separate table rather than nullable columns on the step, so the roomless common case stays
-- untouched and nothing has to interpret "roomId is null" as a mode.
--
-- `mode = 'scribe'` means ONE session represents the whole room. That is why `currentRoomId` sits
-- on the RUN as well as `roomId` on the leg: a participant watching a scribe write has no leg of
-- their own, and the facilitator still needs to see them placed in a room.
--
-- Insights carry `roomId` because rooms are synthesised SEPARATELY — they may have answered
-- different questionnaires, and combining them would be the same cross-vocabulary mistake that
-- per-step report scoping exists to avoid.
--
-- Every new pointer is a plain String with no FK (UG-1): deleting a room from a draft agenda must
-- not cascade away the answers given in it. Only the room→step edge is a real relation, because
-- that one is pure config.
--
-- HAND-STRIPPED of the five phantom `DROP INDEX idx_*` statements and the phantom
-- `ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT`. Applied with
-- `migrate deploy`; indexes verified intact afterwards.

-- AlterTable
ALTER TABLE "app_experience_insight" ADD COLUMN     "roomId" TEXT;

-- AlterTable
ALTER TABLE "app_experience_run" ADD COLUMN     "currentRoomId" TEXT;

-- AlterTable
ALTER TABLE "app_experience_run_leg" ADD COLUMN     "roomId" TEXT;

-- CreateTable
CREATE TABLE "app_experience_breakout_room" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "questionnaireId" TEXT,
    "versionId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'individual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_experience_breakout_room_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_experience_breakout_room_stepId_idx" ON "app_experience_breakout_room"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "app_experience_breakout_room_stepId_name_key" ON "app_experience_breakout_room"("stepId", "name");

-- CreateIndex
CREATE INDEX "app_experience_insight_meetingId_stepId_roomId_idx" ON "app_experience_insight"("meetingId", "stepId", "roomId");

-- CreateIndex
CREATE INDEX "app_experience_run_leg_roomId_idx" ON "app_experience_run_leg"("roomId");

-- AddForeignKey
ALTER TABLE "app_experience_breakout_room" ADD CONSTRAINT "app_experience_breakout_room_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "app_experience_step"("id") ON DELETE CASCADE ON UPDATE CASCADE;
