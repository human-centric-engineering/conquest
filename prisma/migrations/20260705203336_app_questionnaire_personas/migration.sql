-- Selectable interviewer personas (F-persona).
-- Persona library + respondent-selection toggle on the version config, and the respondent's choice
-- on the session. (Phantom pgvector DROP INDEX / searchVector DROP DEFAULT statements that Prisma
-- generates against the vector-index columns are intentionally omitted — see the app-migration
-- create-only workflow.)

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "personaSelection" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "personas" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "selectedPersonaKey" TEXT;
