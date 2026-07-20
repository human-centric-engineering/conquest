-- Experiences (F15.5a): the facilitator-set breakout length and the post-clock grace window.
--
-- The clock ending and the room being done are not the same moment. `breakoutGraceSeconds` is the
-- window after `breakoutEndsAt` in which participants may FINISH and submit what they are mid-way
-- through — but not begin something new, since an answer started after the bell will not be part of
-- the conversation the room is about to have. Cutting both off at once loses answers people had
-- already written.
--
-- `breakoutDurationSeconds` records what the facilitator actually chose for THIS occurrence, which
-- may differ from the step's authored default: the room in front of them decides whether twelve
-- minutes is right today.
--
-- Both are frozen at breakout start rather than read live from settings, for the same reason
-- `breakoutEndsAt` is stored: a room mid-sentence must not lose its remaining seconds because
-- somebody edited a setting.
--
-- Default 30 rather than 0 so existing and future rows behave humanely without configuration.
--
-- HAND-STRIPPED of the five phantom `DROP INDEX idx_*` statements and the phantom
-- `ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT` (a GENERATED ALWAYS
-- column Prisma cannot model). Applied with `migrate deploy`; indexes verified intact afterwards.

-- AlterTable
ALTER TABLE "app_experience_meeting" ADD COLUMN     "breakoutDurationSeconds" INTEGER,
ADD COLUMN     "breakoutGraceSeconds" INTEGER NOT NULL DEFAULT 30;
