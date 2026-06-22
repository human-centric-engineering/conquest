-- CreateTable
CREATE TABLE "app_round_phase" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "subgroupId" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "endMode" TEXT NOT NULL DEFAULT 'hard',
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_round_phase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_round_phase_roundId_idx" ON "app_round_phase"("roundId");

-- CreateIndex
CREATE INDEX "app_round_phase_subgroupId_idx" ON "app_round_phase"("subgroupId");

-- CreateIndex
CREATE UNIQUE INDEX "app_round_phase_roundId_subgroupId_key" ON "app_round_phase"("roundId", "subgroupId");

-- AddForeignKey
ALTER TABLE "app_round_phase" ADD CONSTRAINT "app_round_phase_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "app_questionnaire_round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_round_phase" ADD CONSTRAINT "app_round_phase_subgroupId_fkey" FOREIGN KEY ("subgroupId") REFERENCES "app_cohort_subgroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
