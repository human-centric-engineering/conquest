-- Experiences (F15.4): denormalise the experience STEP onto the session.
--
-- Per-step cohort reports must be expressible as a plain session `where` clause: `ReportScope` /
-- `scopeSessionWhere` are pure, and the dataset + chart-series modules assume one data-slot
-- vocabulary per scope. `AppExperienceRunLeg.sessionId` is an unmodelled UG-1 pointer, so there is
-- no relation to join through — hence the same denormalisation posture already used for
-- `roundId` / `cohortMemberId` / `cohortSubgroupId`.
--
-- Nullable with no backfill: every existing session predates experiences and is correctly null.
--
-- HAND-STRIPPED. Prisma's diff engine cannot see the raw-SQL pgvector/tsvector indexes or the
-- generated `searchVector` default, so the generated file also proposed:
--   DROP INDEX idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
--              idx_message_embedding, idx_app_data_slot_embedding,
--              idx_app_question_slot_embedding
--   ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT
-- All six were removed. Applied with `migrate deploy`, and the five vector indexes were verified
-- present afterwards. See .context/app/questionnaire/experiences.md ("Migrations need
-- hand-stripping") and the DRIFT WARNING on app_questionnaire_session.

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "experienceStepId" TEXT;

-- CreateIndex
CREATE INDEX "app_questionnaire_session_experienceStepId_idx" ON "app_questionnaire_session"("experienceStepId");
