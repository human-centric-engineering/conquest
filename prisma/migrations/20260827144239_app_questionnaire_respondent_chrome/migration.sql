-- F-chrome: how much of ConQuest shows AROUND the respondent surface, per questionnaire version.
--
-- Orthogonal to `respondentLayout` (which arranges the questionnaire's own parts inside whatever
-- this leaves). Defaults to 'full' — the site header and footer every respondent page has always
-- had — so every existing version renders exactly as it did before this column existed, with no
-- backfill. An unrecognised value also resolves to 'full' in the app layer, so a rollback cannot
-- strip a live respondent's page of its chrome.
--
-- NOTE: `prisma migrate dev --create-only` also emitted DROP INDEX for the five pgvector indexes
-- (idx_ai_knowledge_chunk_search_vector, idx_knowledge_embedding, idx_message_embedding,
-- idx_app_data_slot_embedding, idx_app_question_slot_embedding) and a DROP DEFAULT on
-- ai_knowledge_chunk."searchVector". Those are phantom — Prisma cannot see the raw-SQL index
-- definitions — and applying them destroys the knowledge-base and semantic-matching indexes. They
-- have been stripped by hand, as in every other app migration here; a schema-guard test asserts
-- they never leak back in.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "respondentChrome" TEXT NOT NULL DEFAULT 'full';
