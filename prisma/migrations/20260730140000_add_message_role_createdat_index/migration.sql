-- DropIndex
DROP INDEX "ai_message_role_idx";

-- CreateIndex
CREATE INDEX "ai_message_role_createdAt_idx" ON "ai_message"("role", "createdAt");
