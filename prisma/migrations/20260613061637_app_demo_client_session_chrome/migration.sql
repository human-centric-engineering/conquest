-- DEMO-ONLY (F7.1+): respondent-session brand chrome columns on app_demo_client.
-- surfaceColor / ctaColorEnd / logoBackgroundColor are nullable (null = Sunrise default);
-- logoBackgroundEnabled is the "apply this colour behind the logo" toggle (default off).
--
-- NB: prisma migrate diff re-emits phantom DROP INDEX / DROP DEFAULT for the pgvector
-- search indexes (Prisma can't model them). Those were stripped — applying them would
-- drop the platform's vector search indexes. See the app-migration create-only note.
ALTER TABLE "app_demo_client" ADD COLUMN     "ctaColorEnd" TEXT,
ADD COLUMN     "logoBackgroundColor" TEXT,
ADD COLUMN     "logoBackgroundEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "surfaceColor" TEXT;
