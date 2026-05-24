-- Phase 2 of MCP gap-closure: tool annotations + prompt admin model.
--
-- This migration deliberately does NOT include the unrelated drift Prisma
-- detected (raw-SQL search-vector indexes, AI conversation index rename,
-- search vector default) — those are not introduced by this change and
-- dropping load-bearing GIN/HNSW indexes is destructive. They should be
-- handled separately if intentional.

-- AlterTable: MCP 2025-06-18 tool annotations (advisory hints)
ALTER TABLE "mcp_exposed_tool" ADD COLUMN     "customTitle" TEXT,
ADD COLUMN     "destructiveHint" BOOLEAN,
ADD COLUMN     "idempotentHint" BOOLEAN,
ADD COLUMN     "openWorldHint" BOOLEAN,
ADD COLUMN     "readOnlyHint" BOOLEAN;

-- CreateTable: MCP prompt admin surface
CREATE TABLE "mcp_exposed_prompt" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "argumentsSpec" JSONB NOT NULL,
    "completionsSpec" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_exposed_prompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_exposed_prompt_name_key" ON "mcp_exposed_prompt"("name");

-- CreateIndex
CREATE INDEX "mcp_exposed_prompt_isEnabled_idx" ON "mcp_exposed_prompt"("isEnabled");

-- AddForeignKey
ALTER TABLE "mcp_exposed_prompt" ADD CONSTRAINT "mcp_exposed_prompt_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
