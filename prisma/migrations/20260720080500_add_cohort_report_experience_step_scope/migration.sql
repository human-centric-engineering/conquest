-- Experiences (F15.4): the experience-step owner key for cohort reports.
--
-- Extends the existing polymorphic owner pattern (round | version) with a third kind. Exactly one
-- of the three nullable-unique owner keys is set per row; Postgres allows multiple NULLs in a
-- unique index, so each still enforces "one report per owner" without colliding.
--
-- Scoped PER STEP, not per experience: one step pins one questionnaire version, so `versionId`
-- stays set on every row and buildCohortDataset / chart-series.ts keep their single-data-slot-
-- vocabulary assumption and need zero changes. An experience-wide view is a synthesis over ready
-- step reports, never a re-aggregation across versions whose slot keys do not reconcile.
--
-- No FK (UG-1): a step is experience CONFIG, and a real relation would let editing a journey
-- cascade away a generated report about respondents who already ran it.
--
-- HAND-STRIPPED. Prisma's diff engine cannot see the raw-SQL pgvector/tsvector indexes or the
-- GENERATED ALWAYS `searchVector` column, so the generated diff also proposed:
--   DROP INDEX idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
--              idx_message_embedding, idx_app_data_slot_embedding,
--              idx_app_question_slot_embedding
--   ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT
-- All six were removed. Applied with `migrate deploy`; the five vector indexes and the
-- searchVector generation expression were verified intact afterwards.

-- AlterTable
ALTER TABLE "app_cohort_report" ADD COLUMN     "experienceStepOwnerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_report_experienceStepOwnerId_key" ON "app_cohort_report"("experienceStepOwnerId");
