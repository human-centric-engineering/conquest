-- Append-only erasure receipt (GDPR Art. 5(2) accountability).
-- Written in the same transaction as the user delete; see lib/privacy/erase-user.ts.

-- CreateTable
CREATE TABLE "data_erasure_receipt" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "subjectEmailHash" TEXT,
    "actorUserId" TEXT,
    "reason" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "data_erasure_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_erasure_receipt_subjectUserId_idx" ON "data_erasure_receipt"("subjectUserId");

-- CreateIndex
CREATE INDEX "data_erasure_receipt_erasedAt_idx" ON "data_erasure_receipt"("erasedAt");

