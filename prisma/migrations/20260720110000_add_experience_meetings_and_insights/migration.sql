-- Experiences (F15.5a): facilitated meetings — the live occurrence, its breakout clock, and the
-- synthesised insights a facilitator walks the room through.
--
-- A breakout is a PERIOD OF TIME in a meeting, not a place. `AppExperienceRun` cannot carry this:
-- a run is ONE respondent's journey, whereas a meeting is the shared fact that a group is doing
-- this together right now. Hence a meeting entity above the runs, owning what belongs to the
-- occurrence — which breakout is live, and when its clock started.
--
-- The DURATION lives on the step (authored intent, reused every time the agenda runs); the CLOCK
-- lives on the meeting (this occurrence started at 14:03). `breakoutEndsAt` is stored rather than
-- derived so an author editing the duration mid-meeting cannot retroactively move a clock the room
-- is already watching.
--
-- `AppExperienceInsight.supportCount` backs the k-anonymity gate (`insightMinSupport`, default 3):
-- two people can identify each other from "a tension between two of you"; three is the smallest
-- group where that stops being true. Stored rather than only applied at generation, so raising the
-- setting later makes an EXISTING meeting safer without re-running the synthesis.
--
-- Both new FKs cascade and both are respondent-data edges, not CONFIG→answer edges, so UG-1 does
-- not apply: a run has no meaning without its meeting, an insight none without the meeting it
-- synthesised. `currentStepId` / `stepId` stay unmodelled pointers — deleting a step from a draft
-- experience must not cascade away a meeting that already ran it.
--
-- HAND-STRIPPED. Prisma's diff engine cannot see the raw-SQL pgvector/tsvector indexes or the
-- GENERATED ALWAYS `searchVector` column, so the generated diff also proposed five
-- `DROP INDEX idx_*` statements plus
-- `ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT`.
-- All six were removed. Applied with `migrate deploy`; indexes verified intact afterwards.


-- AlterTable
ALTER TABLE "app_experience_run" ADD COLUMN     "meetingId" TEXT;

-- AlterTable
ALTER TABLE "app_experience_step" ADD COLUMN     "briefing" TEXT,
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "synthesisFocus" TEXT;

-- CreateTable
CREATE TABLE "app_experience_meeting" (
    "id" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "joinRef" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "currentStepId" TEXT,
    "breakoutStartedAt" TIMESTAMP(3),
    "breakoutEndsAt" TIMESTAMP(3),
    "facilitatorUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_experience_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_experience_insight" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "detail" TEXT,
    "supportCount" INTEGER NOT NULL DEFAULT 0,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "covered" BOOLEAN NOT NULL DEFAULT false,
    "visibleToRespondents" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_experience_insight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_experience_meeting_joinRef_key" ON "app_experience_meeting"("joinRef");

-- CreateIndex
CREATE INDEX "app_experience_meeting_experienceId_idx" ON "app_experience_meeting"("experienceId");

-- CreateIndex
CREATE INDEX "app_experience_meeting_status_idx" ON "app_experience_meeting"("status");

-- CreateIndex
CREATE INDEX "app_experience_insight_meetingId_stepId_ordinal_idx" ON "app_experience_insight"("meetingId", "stepId", "ordinal");

-- CreateIndex
CREATE INDEX "app_experience_insight_meetingId_stepId_supportCount_idx" ON "app_experience_insight"("meetingId", "stepId", "supportCount");

-- CreateIndex
CREATE INDEX "app_experience_run_meetingId_idx" ON "app_experience_run"("meetingId");

-- AddForeignKey
ALTER TABLE "app_experience_run" ADD CONSTRAINT "app_experience_run_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "app_experience_meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_experience_meeting" ADD CONSTRAINT "app_experience_meeting_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "app_experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_experience_insight" ADD CONSTRAINT "app_experience_insight_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "app_experience_meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
