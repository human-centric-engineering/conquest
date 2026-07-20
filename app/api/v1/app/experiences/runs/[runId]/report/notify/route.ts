/**
 * Opt in to an email when a run-level report is ready (F15.4b deferred item).
 *
 * POST /api/v1/app/experiences/runs/:runId/report/notify   body: { email }
 *
 * A journey's report can take a minute to generate, and a respondent who has just finished a
 * meeting or a multi-part questionnaire should not have to sit watching a spinner. Mirrors the
 * per-session notify route.
 *
 * Only accepts an opt-in while there is still something to notify ABOUT: a report already `ready`
 * needs no email, and one that `failed` would promise something that is not coming.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';

const notifySchema = z.object({
  email: z.string().trim().email().max(320),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const log = await getRouteLogger(request);
  const { runId } = await params;

  try {
    const limit = runPollLimiter.check(getClientIP(request));
    if (!limit.success) return createRateLimitResponse(limit);

    const access = await canReadRun(request, runId);
    // No admin bypass: an admin has no business attaching an address to someone else's report.
    if (!access.allowed || access.isAdmin) {
      return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Throws on a malformed body or a bad address; the catch below turns that into the standard
    // 400 envelope rather than letting it escape as an unhandled 500.
    const body = await validateRequestBody(request, notifySchema);

    const report = await prisma.appRespondentReport.findUnique({
      where: { runId },
      select: { id: true, status: true },
    });
    if (!report)
      return errorResponse('No report to notify about', { code: 'NO_REPORT', status: 409 });

    // The state gate lives IN the write, not before it: between a separate check and update the
    // worker can finish the report — it writes `ready` and clears `notifyEmail` — and an address
    // re-attached afterwards would never be sent and never cleared, leaving the view promising an
    // email forever. `queued`/`processing` are the only states with a send still ahead of them,
    // and the worker re-reads notifyEmail just before writing `ready` so a late opt-in still lands.
    const updated = await prisma.appRespondentReport.updateMany({
      where: { id: report.id, status: { in: ['queued', 'processing'] } },
      data: { notifyEmail: body.email },
    });

    if (updated.count === 0) {
      return errorResponse('That report is no longer being generated', {
        code: 'NOT_IN_FLIGHT',
        status: 409,
      });
    }

    log.info('Run report notify requested', { runId });
    return successResponse({ notifying: true });
  } catch (err) {
    return handleAPIError(err);
  }
}
