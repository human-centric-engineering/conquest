/**
 * Respondent report — respondent-facing status + content.
 *
 * GET /api/v1/app/questionnaire-sessions/:id/report
 *   Serves both respondent kinds (authenticated owner + no-login anonymous, via `resolveTurnAccess`).
 *   Returns whether a report is enabled, its mode + delivery, and — for `raw_plus_insights` — the
 *   generation status and (once ready) the insights content. The completion screen polls this until
 *   the status is terminal.
 *
 *   Gate order: live-sessions flag (404 before auth) → load → access (401/403) → view.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { prisma } from '@/lib/db/client';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { buildRespondentReportClientView } from '@/lib/app/questionnaire/report/view';

async function handleGetReport(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
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

    const view = await buildRespondentReportClientView(sessionId);
    if (!view) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    return successResponse(view);
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleGetReport);
