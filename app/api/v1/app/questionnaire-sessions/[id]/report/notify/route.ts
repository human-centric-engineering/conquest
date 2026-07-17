/**
 * Respondent report notify — "email me when my report is ready".
 *
 * POST /api/v1/app/questionnaire-sessions/:id/report/notify   body: { email }
 *   Stores the respondent's email on the (already-enqueued) report row; the worker sends a
 *   report-ready email best-effort when generation completes, then clears it. Serves both
 *   respondent kinds (authenticated owner + no-login anonymous, via `resolveTurnAccess`). An
 *   anonymous respondent has no account email, so this captures one explicitly — stored only on
 *   the report row, never on a user record.
 *
 *   Gate order: live-sessions flag (404 before auth) → parse (400) → load → access (401/403) → save.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';

const notifyBodySchema = z.object({ email: z.string().email().max(320) }).strict();

async function handleNotifyReport(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return errorResponse('Invalid JSON in request body', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }
    const result = notifyBodySchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse('A valid email is required', { code: 'VALIDATION_ERROR', status: 400 });
    }

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Only sets the email when a report row exists (AI modes enqueue one at submit). If the report
    // is already `ready`, there's nothing to notify — count 0 reads as `notifying: false`.
    const updated = await prisma.appRespondentReport.updateMany({
      where: { sessionId, status: { in: ['queued', 'processing'] } },
      data: { notifyEmail: result.data.email },
    });

    const notifying = updated.count > 0;
    log.info('Respondent report notify requested', { sessionId, notifying });
    return successResponse({ notifying });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleNotifyReport;
