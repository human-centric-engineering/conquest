-- AlterTable
ALTER TABLE "app_cohort" ADD COLUMN     "introBackground" TEXT;

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "intro" JSONB NOT NULL DEFAULT '{}';
