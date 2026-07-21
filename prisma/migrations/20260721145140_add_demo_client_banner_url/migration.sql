-- DEMO-ONLY (F7.2): full-bleed header banner for a demo client's respondent session.
-- Nullable: null = no banner (the header band renders the logo or the ConQuest wordmark).
--
-- NOTE: Prisma also generated DROP INDEX statements for the five pgvector indexes and a
-- DROP DEFAULT on ai_knowledge_chunk.searchVector. Those are phantom diffs — the vector
-- indexes are created by raw SQL that the Prisma schema cannot model, so every app
-- migration "discovers" them as drift. They are stripped deliberately; applying them
-- would silently destroy the knowledge-base and semantic-slot indexes.
ALTER TABLE "app_demo_client" ADD COLUMN "bannerUrl" TEXT;
