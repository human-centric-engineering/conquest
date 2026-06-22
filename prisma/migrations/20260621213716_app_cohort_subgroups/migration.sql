-- AlterTable
ALTER TABLE "app_cohort_member" ADD COLUMN     "subgroupId" TEXT;

-- CreateTable
CREATE TABLE "app_cohort_subgroup" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_cohort_subgroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_cohort_subgroup_cohortId_idx" ON "app_cohort_subgroup"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "app_cohort_subgroup_cohortId_name_key" ON "app_cohort_subgroup"("cohortId", "name");

-- CreateIndex
CREATE INDEX "app_cohort_member_subgroupId_idx" ON "app_cohort_member"("subgroupId");

-- AddForeignKey
ALTER TABLE "app_cohort_member" ADD CONSTRAINT "app_cohort_member_subgroupId_fkey" FOREIGN KEY ("subgroupId") REFERENCES "app_cohort_subgroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_cohort_subgroup" ADD CONSTRAINT "app_cohort_subgroup_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "app_cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
