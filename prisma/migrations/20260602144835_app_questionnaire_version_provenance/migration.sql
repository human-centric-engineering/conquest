-- F2.1 (P2): persist goal/audience provenance on the version.
--
-- Adds `goalProvenance` (FieldProvenance: admin-supplied | inferred | pre-existing)
-- and `audienceProvenance` (per-field FieldProvenance map) to
-- app_questionnaire_version, so the admin read surface marks AI-inferred values
-- without re-deriving them from the extraction change log.
--
-- Phantom DDL stripped (Prisma 7 schema-fold footgun — see
-- .context/app/questionnaire/schema.md): `migrate dev` prepended DROP INDEX of the
-- three pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding) and an
-- `ALTER TABLE "ai_knowledge_chunk" ... "searchVector" DROP DEFAULT`. The database
-- is correct; the diff is wrong. Only the app ALTER below is ours.

-- AlterTable
ALTER TABLE "app_questionnaire_version" ADD COLUMN     "audienceProvenance" JSONB,
ADD COLUMN     "goalProvenance" TEXT;
