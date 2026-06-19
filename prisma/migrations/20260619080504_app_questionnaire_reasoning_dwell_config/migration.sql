-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "reasoningStreamDwellMs" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "reasoningStreamPerItemMs" INTEGER NOT NULL DEFAULT 330;
