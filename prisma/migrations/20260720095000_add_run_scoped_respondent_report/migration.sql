-- Experiences (F15.4b): make the respondent report polymorphic — one session, or one RUN.
--
-- A run report's inputs span several sessions, which `sessionId @unique` forbids by construction.
-- Mirrors the owner pattern AppCohortReport already uses: exactly one nullable-unique owner key is
-- set per row, and Postgres permits multiple NULLs in a unique index so both coexist.
--
-- `sessionId` drops NOT NULL. Every existing row keeps its value and picks up the
-- `subjectKind = 'session'` default, so no backfill is needed and no read path changes meaning.
--
-- The `runId` FK cascades, matching how app_experience_run_leg attaches to its run: a run is
-- respondent data, not config, so deleting one must take its report with it. (UG-1 forbids
-- CONFIG→answer edges; the run is the answer side, so a real relation is correct here.)
--
-- HAND-STRIPPED. Prisma's diff engine cannot see the raw-SQL pgvector/tsvector indexes or the
-- GENERATED ALWAYS `searchVector` column, so the generated diff also proposed:
--   DROP INDEX idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding,
--              idx_message_embedding, idx_app_data_slot_embedding,
--              idx_app_question_slot_embedding
--   ALTER TABLE ai_knowledge_chunk ALTER COLUMN "searchVector" DROP DEFAULT
-- All six were removed. Applied with `migrate deploy`; indexes verified intact afterwards.

-- AlterTable
ALTER TABLE "app_respondent_report" ADD COLUMN     "runId" TEXT,
ADD COLUMN     "subjectKind" TEXT NOT NULL DEFAULT 'session',
ALTER COLUMN "sessionId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "app_respondent_report_runId_key" ON "app_respondent_report"("runId");

-- AddForeignKey
ALTER TABLE "app_respondent_report" ADD CONSTRAINT "app_respondent_report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "app_experience_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
