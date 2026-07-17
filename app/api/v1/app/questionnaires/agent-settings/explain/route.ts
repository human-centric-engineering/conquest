/**
 * POST /api/v1/app/questionnaires/agent-settings/explain
 *
 * Admin-only, flag-gated. The hybrid "Explain with AI" layer of the Agent
 * Settings Evaluation surface: given an agent slug, runs one reasoning-model
 * structured completion and returns a plain-language explanation plus an optional
 * applyable suggestion. Per-admin rate-limited (LLM sub-flow).
 *
 * Applying a suggestion goes through the existing agent PATCH endpoint.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { settingsAdvisorLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { explainAgentSettings } from '@/lib/app/questionnaire/agent-advisory/explain';

const bodySchema = z.object({ slug: z.string().min(1).max(100) });

const handlePost = withAdminAuth(async (request: NextRequest, session) => {
  const adminId = session.user.id;

  const rl = settingsAdvisorLimiter.check(adminId);
  if (!rl.success) {
    logger.warn('agent-settings explain rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  let parsed: { slug: string };
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return errorResponse('A valid agent slug is required', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  const result = await explainAgentSettings(parsed.slug);
  if (!result.ok) {
    const status = result.code === 'agent_not_found' ? 404 : 503;
    return errorResponse(result.message, { code: result.code.toUpperCase(), status });
  }

  return successResponse(result.value);
});

export const POST = handlePost;
