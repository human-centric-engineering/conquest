-- Experience-wide synthesis (P15.8): one view across a whole journey, synthesised over FINISHED
-- per-step outputs (ready cohort reports for a switcher, k-anonymity-gated insights for a
-- facilitated meeting) — never a re-aggregation of sessions across steps.
--
-- Its own table rather than a fourth AppCohortReport scope: that model's `versionId` is NOT NULL
-- because each of its scopes analyses exactly one questionnaire version, and an experience spans
-- versions by definition.
--
-- NOTE: `prisma migrate diff` also emitted five phantom DROP INDEX statements (the pgvector
-- embedding indexes and the ai_knowledge_chunk tsvector index) plus an
-- `ALTER COLUMN "searchVector" DROP DEFAULT`. All six are artefacts of Prisma not modelling raw-SQL
-- indexes or GENERATED ALWAYS columns, and all six were stripped by hand. Applying them would drop
-- live vector indexes and break knowledge search.

-- CreateTable
CREATE TABLE "app_experience_synthesis" (
    "id" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "content" JSONB,
    "coveredSteps" INTEGER NOT NULL DEFAULT 0,
    "eligibleSteps" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_experience_synthesis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_experience_synthesis_experienceId_key" ON "app_experience_synthesis"("experienceId");

-- CreateIndex
CREATE INDEX "app_experience_synthesis_status_idx" ON "app_experience_synthesis"("status");

-- AddForeignKey
ALTER TABLE "app_experience_synthesis" ADD CONSTRAINT "app_experience_synthesis_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "app_experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;
