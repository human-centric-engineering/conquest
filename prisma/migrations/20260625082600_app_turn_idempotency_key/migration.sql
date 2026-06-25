-- Retry idempotency (F7.x): a client-minted key per send attempt, reused across that attempt's
-- retries, so a turn the server already persisted is replayed (not duplicated) when a retry re-runs
-- it. NULLs stay distinct under the unique, so existing/key-less turns are unaffected.
--
-- NOTE: the phantom pgvector `DROP INDEX` / `DROP DEFAULT` statements Prisma's diff emits for the
-- raw-SQL vector indexes (idx_*_embedding, ai_knowledge_chunk.searchVector) are deliberately omitted
-- — they are not real drift, and applying them would tear down platform indexes Prisma can't model.

-- AlterTable
ALTER TABLE "app_questionnaire_turn" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_turn_sessionId_idempotencyKey_key" ON "app_questionnaire_turn"("sessionId", "idempotencyKey");
