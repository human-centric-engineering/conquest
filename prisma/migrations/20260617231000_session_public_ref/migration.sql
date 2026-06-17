-- AddColumn: short, human-readable support reference per session (nullable; existing rows carry none).
ALTER TABLE "app_questionnaire_session" ADD COLUMN "publicRef" TEXT;

-- CreateIndex: unique (Postgres permits many NULLs under a unique index).
CREATE UNIQUE INDEX "app_questionnaire_session_publicRef_key" ON "app_questionnaire_session"("publicRef");
