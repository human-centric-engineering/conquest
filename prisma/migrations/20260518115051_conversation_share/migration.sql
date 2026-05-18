-- Consent record for cross-user conversation access.
--
-- End users own their conversations. An admin (or any other user) can
-- view another user's conversation only when the owner has explicitly
-- created an active share. The unique constraint on conversationId
-- means a conversation has at most one share row at a time —
-- re-sharing after a revoke updates the existing row.
--
-- Active = revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())
--
-- Non-destructive. No data backfill — absence of share rows means
-- consent-by-absence, which is the correct default (admins see only
-- their own conversations).
--
-- Reference: .context/security/conversation-access.md

CREATE TABLE "ai_conversation_share" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "reason"         TEXT,
  "expiresAt"      TIMESTAMP(3),
  "revokedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_conversation_share_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_conversation_share_conversationId_key"
  ON "ai_conversation_share" ("conversationId");

CREATE INDEX "ai_conversation_share_expiresAt_idx"
  ON "ai_conversation_share" ("expiresAt");

ALTER TABLE "ai_conversation_share"
  ADD CONSTRAINT "ai_conversation_share_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
