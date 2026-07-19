/**
 * GET /api/v1/app/questionnaires/agent-settings
 *
 * Admin-only. Returns the deterministic Agent Settings Evaluation:
 * each questionnaire agent's current model / temperature / maxTokens / reasoning
 * effort versus the curated advisory recommendation, with cost trade-offs and
 * real 30-day spend, plus the task-tier and infra default evaluations.
 *
 * Read-only — applying recommendations goes through the existing orchestration
 * settings PATCH (task-tier model defaults) and agent PATCH (per-agent fields).
 */

import type { NextRequest } from 'next/server';

import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { evaluateAgentSettings } from '@/lib/app/questionnaire/agent-advisory/evaluate';

const handleGet = withAdminAuth(async (_request: NextRequest) => {
  const evaluation = await evaluateAgentSettings();

  logger.info('agent-settings: served evaluation', {
    agentCount: evaluation.agents.length,
    optimal: evaluation.agents.filter((a) => a.isOptimal).length,
  });

  return successResponse(evaluation);
});

export const GET = handleGet;
