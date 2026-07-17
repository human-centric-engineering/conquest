/**
 * Respondent report retry — respondent-facing "Check again" re-trigger.
 *
 * POST /api/v1/app/questionnaire-sessions/:id/report/retry
 *   Re-queues a stuck (`failed` / orphaned-`processing`) report and kicks the worker so it
 *   regenerates without waiting for the next maintenance cron. Serves both respondent kinds
 *   (authenticated owner + no-login anonymous, via `resolveTurnAccess`). No-op-safe: a `ready`
 *   or fresh in-flight report is left untouched.
 *
 *   Gate order: live-sessions flag (404 before auth) → load → access (401/403) → retry.
 */

import type { NextRequest } from 'next/server';
import { after } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { requestRespondentReportRetry } from '@/lib/app/questionnaire/report/retry';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';

async function handleRetryReport(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const { requeued } = await requestRespondentReportRetry(sessionId);
    log.info('Respondent report retry requested', { sessionId, requeued });

    // Kick the worker after the response (serverless-safe) so a re-queued report — or one that was
    // simply never drained — regenerates within seconds rather than at the next cron minute.
    after(async () => {
      try {
        await processQueuedRespondentReports();
      } catch (err) {
        log.error('Respondent report retry kick failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return successResponse({ requeued });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleRetryReport;
