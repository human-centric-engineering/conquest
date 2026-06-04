-- F3.2: questionnaire invitations.
--
-- Schema-fold strip applied by hand: `prisma migrate dev` re-emitted DROPs of the
-- platform's pgvector indexes (idx_ai_knowledge_chunk_search_vector,
-- idx_knowledge_embedding, idx_message_embedding) and an ALTER of the GENERATED
-- ai_knowledge_chunk."searchVector" column — Prisma-unmodelled objects with no
-- bearing on this app table. They are removed so this migration is a clean additive
-- CREATE; the schema-guard test asserts they never leak back in.

-- CreateTable
CREATE TABLE "app_questionnaire_invitation" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_questionnaire_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_questionnaire_invitation_tokenHash_key" ON "app_questionnaire_invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_versionId_idx" ON "app_questionnaire_invitation"("versionId");

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_status_idx" ON "app_questionnaire_invitation"("status");

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_email_idx" ON "app_questionnaire_invitation"("email");

-- CreateIndex
CREATE INDEX "app_questionnaire_invitation_userId_idx" ON "app_questionnaire_invitation"("userId");

-- AddForeignKey
ALTER TABLE "app_questionnaire_invitation" ADD CONSTRAINT "app_questionnaire_invitation_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "app_questionnaire_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
