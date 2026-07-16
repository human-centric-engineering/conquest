/**
 * GET /api/v1/app/questionnaires/prompts
 *
 * Admin-only, flag-gated. Returns every questionnaire agent paired with the exact
 * prompt(s) it sends (rendered from representative sample contexts by the catalog)
 * AND its seeded DB binding — so an operator can read the real, load-bearing prompts
 * that the editable `systemInstructions` field does not drive. Read-only: builds the
 * catalog in-process and reads agent rows; persists nothing.
 */

import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import {
  buildPromptCatalog,
  type PromptAgentApiView,
} from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';

const handleGet = withAdminAuth(async (_request: NextRequest) => {
  const catalog = buildPromptCatalog();
  const slugs = catalog.map((entry) => entry.slug);

  const rows = await prisma.aiAgent.findMany({
    where: { slug: { in: slugs } },
    select: {
      slug: true,
      provider: true,
      model: true,
      temperature: true,
      maxTokens: true,
      monthlyBudgetUsd: true,
      visibility: true,
      isActive: true,
      systemInstructions: true,
    },
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  const agents: PromptAgentApiView[] = catalog.map((entry) => {
    const row = bySlug.get(entry.slug);
    if (!row) {
      return { ...entry, seeded: false, binding: null, storedInstructions: null };
    }
    const provider = row.provider ?? '';
    const model = row.model ?? '';
    return {
      ...entry,
      seeded: true,
      storedInstructions: row.systemInstructions ?? null,
      binding: {
        provider,
        model,
        resolvesAtRuntime: provider.trim() === '' && model.trim() === '',
        temperature: row.temperature ?? null,
        maxTokens: row.maxTokens ?? null,
        monthlyBudgetUsd: row.monthlyBudgetUsd ?? null,
        visibility: row.visibility ?? null,
        isActive: row.isActive,
      },
    };
  });

  logger.info('prompt library: served catalog', {
    agentCount: agents.length,
    seeded: agents.filter((a) => a.seeded).length,
  });

  return successResponse({ agents });
});

export const GET = handleGet;
