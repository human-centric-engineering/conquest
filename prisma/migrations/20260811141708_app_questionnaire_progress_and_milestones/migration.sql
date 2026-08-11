-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "milestoneBannerEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "milestoneBannerThresholds" JSONB NOT NULL DEFAULT '[25,50,75,90]',
ADD COLUMN     "showProgressPercentText" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "app_questionnaire_session" ADD COLUMN     "raisedMilestones" JSONB NOT NULL DEFAULT '[]';
