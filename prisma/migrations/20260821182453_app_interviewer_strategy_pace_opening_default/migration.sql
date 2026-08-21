-- Interviewer strategy: carry the pace + opening-question fields in the column default, so a
-- freshly created config row is correct at rest rather than relying on the read-path narrower.
--
-- No backfill. Existing rows keep whatever JSON they already store; `narrowInterviewerStrategy`
-- fills `pace: 'balanced'` / `openingMode: 'auto'` / `openingExamples: []` on every read, and those
-- defaults reproduce the pre-feature behaviour exactly. A DEFAULT applies only to new rows, so this
-- statement cannot change how any existing questionnaire behaves.
--
-- Generated with `--create-only` and hand-stripped: `prisma migrate dev` also emitted five
-- `DROP INDEX` statements for the pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding, idx_app_data_slot_embedding,
-- idx_app_question_slot_embedding) plus an `ALTER COLUMN "searchVector" DROP DEFAULT`. Those are
-- phantom DDL — Prisma cannot model those index types or the generated tsvector, so it proposes
-- dropping them on every app migration. Applying them would destroy the vector search indexes.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ALTER COLUMN "interviewerStrategy" SET DEFAULT '{"enabled":true,"approach":"funnel","pace":"balanced","openingMode":"auto","openingExamples":[],"probeDepth":true,"reflect":false,"batchRelated":true}';
