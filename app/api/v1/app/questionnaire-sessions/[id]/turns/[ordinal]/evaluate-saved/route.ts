/**
 * Re-evaluate a SAVED turn from its persisted inspector traces.
 *
 * POST /api/v1/app/questionnaire-sessions/:id/turns/:ordinal/evaluate-saved
 *   Admin-only, turn-evaluation-flag-gated, per-admin rate-limited (the same paid reasoning call as
 *   the live evaluator). Reads the turn's saved inspector dump and runs the evaluator over it, then
 *   persists the verdict (returned with its `evaluationId`). Unlike the live `evaluate-turn` route
 *   this is NOT preview-gated — it's how a real chat, found by its `publicRef`, gets judged.
 *
 *   Maps the orchestration result: session/turn missing → 404, no saved traces → 422, evaluator not
 *   configured → 404, evaluator threw → 502.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { withTurnEvaluationEnabled } from '@/lib/app/questionnaire/feature-flag';
import { turnEvaluationLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { runSavedTurnEvaluation } from '@/app/api/v1/app/questionnaire-sessions/_lib/evaluate-saved-turn';

/** The ordinal travels in the path; validate it as a positive integer. */
const ordinalSchema = z.coerce.number().int().positive();

const handleEvaluateSaved = withAdminAuth<{ id: string; ordinal: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, ordinal: ordinalRaw } = await params;
    const adminId = session.user.id;

    const parsedOrdinal = ordinalSchema.safeParse(ordinalRaw);
    if (!parsedOrdinal.success) {
      return errorResponse('Invalid turn ordinal', { code: 'VALIDATION_ERROR', status: 400 });
    }

    // Per-admin sub-cap on the paid reasoning call (mirrors the live evaluator).
    const rl = turnEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Saved-turn evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const result = await runSavedTurnEvaluation({
      sessionId: id,
      ordinal: parsedOrdinal.data,
      adminId,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'no_traces':
          return errorResponse('This turn has no saved inspector traces to evaluate', {
            code: 'no_traces',
            status: 422,
          });
        case 'not_configured':
          return errorResponse('Turn evaluation is not configured', {
            code: 'not_configured',
            status: 404,
          });
        case 'failed':
          return errorResponse('Turn evaluation failed', {
            code: 'evaluation_failed',
            status: 502,
          });
        case 'session_not_found':
          return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });
        default:
          return errorResponse('Turn not found', { code: 'NOT_FOUND', status: 404 });
      }
    }

    log.info('Saved turn evaluated', {
      sessionId: id,
      ordinal: parsedOrdinal.data,
      overallScore: result.verdict.overallScore,
      model: result.model,
      evaluationId: result.evaluationId,
    });

    return successResponse({
      verdict: result.verdict,
      costUsd: result.costUsd,
      model: result.model,
      evaluationId: result.evaluationId,
    });
  }
);

export const POST = withTurnEvaluationEnabled(handleEvaluateSaved);
