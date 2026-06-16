-- Preview Turn Inspector (admin-only): per-version opt-in to the preview-mode agent-call console.
-- (Phantom pgvector index / searchVector DROPs that `prisma migrate dev` emits — because it can't
-- model the pgvector/tsvector DDL — were stripped; only the real ADD COLUMN is applied.)
ALTER TABLE "app_questionnaire_config" ADD COLUMN "previewInspectorEnabled" BOOLEAN NOT NULL DEFAULT false;
