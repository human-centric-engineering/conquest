-- AlterTable
ALTER TABLE "app_answer_slot" ADD COLUMN     "respondentEdited" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "presentationMode" TEXT NOT NULL DEFAULT 'chat';
