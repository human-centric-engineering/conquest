/**
 * Respondent Report — config-crafting assistant turn (Phase 4b).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/report/craft
 *   Admin-only. One conversational turn of the Generation-tab assistant: takes the prior messages +
 *   the editor's current generation config and returns the assistant's reply plus any proposed config
 *   (full field text the admin applies wholesale). Stateless — the client holds the transcript; this
 *   route persists nothing (the admin saves config through the normal config PATCH).
 *
 *   Gate order: withAdminAuth → per-admin assist sub-cap → validate → craft.
 *   The `vid` is accepted for symmetry/routing but the turn is stateless, so it isn't loaded.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';

import {
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';
import { craftReportConfig } from '@/lib/app/questionnaire/report/craft';
import { reportConfigAssistLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** A bounded transcript + the editor's current config values. */
const craftRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(8000),
      })
    )
    .min(1)
    .max(40),
  current: z.object({
    instructions: z.string().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
    structure: z.string().max(RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH),
    backgroundContext: z.string().max(RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH),
  }),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const handleCraft = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    const rl = reportConfigAssistLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Report config assist rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = await validateRequestBody(request, craftRequestSchema);

    try {
      const result = await craftReportConfig({ messages: body.messages, current: body.current });
      log.info('Report config assist turn', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        suggested: Object.keys(result.suggestions),
      });
      return successResponse({ reply: result.reply, suggestions: result.suggestions });
    } catch (err) {
      logger.error('Report config assist failed', { adminId, error: errorMessage(err) });
      return errorResponse('The assistant could not respond. Please try again.', {
        code: 'REPORT_CONFIG_ASSIST_FAILED',
        status: 502,
      });
    }
  }
);

export const POST = handleCraft;
