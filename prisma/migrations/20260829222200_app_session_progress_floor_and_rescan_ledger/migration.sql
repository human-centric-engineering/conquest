-- F17.33: progress under scope widening.
--
-- `progressFloorPct` — presentation state only: the highest whole-percent progress figure the
-- session has displayed, so the bar cannot run backwards when Conditional Topics widens the
-- in-scope question set. `rescannedTopicKeys` — the once-per-topic ledger for re-reading the
-- transcript after a widening.
--
-- Both defaulted, so every existing session reads correctly with no backfill: a floor of 0
-- ratchets nothing, and an empty ledger re-reads nothing that already happened.
--
-- NOTE: Prisma's generated draft also carried DROP INDEX statements for the five pgvector indexes
-- and a DROP DEFAULT on ai_knowledge_chunk.searchVector. Those are phantom diffs — the introspector
-- cannot see raw-SQL index definitions — and were stripped by hand. See
-- .context/database/migrations.md.
-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "progressFloorPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rescannedTopicKeys" JSONB NOT NULL DEFAULT '[]';
