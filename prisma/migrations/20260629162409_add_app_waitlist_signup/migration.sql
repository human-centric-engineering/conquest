-- CreateTable
CREATE TABLE "app_waitlist_signup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "useCase" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "app_waitlist_signup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_waitlist_signup_read_createdAt_idx" ON "app_waitlist_signup"("read", "createdAt");

-- CreateIndex
CREATE INDEX "app_waitlist_signup_email_idx" ON "app_waitlist_signup"("email");
