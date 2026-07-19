/**
 * Experience run advance (P15.2) — the manual retry.
 *
 * POST /api/v1/app/experiences/runs/:runId/advance
 *
 * The submit route's `after()` hook is the normal path; this endpoint exists for the case it
 * cannot cover — the hook was cut off mid-flight (a serverless timeout, a deploy), leaving a run
 * stuck in `awaiting_handoff` with a respondent waiting. An admin can then push it forward without
 * the respondent having to re-submit anything.
 *
 * `withAdminAuth`. Deliberately NOT reachable by the respondent: an advance is the one operation
 * here with real side effects (it mints a session and spends money on a selector call), and a
 * respondent-reachable trigger would let a refresh loop fire it repeatedly. The idempotency
 * constraint would catch that, but not before paying for the selector each time.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { advanceExperienceRun } from '@/app/api/v1/app/experiences/_lib/run-advance';

const handleAdvance = withAdminAuth<{ runId: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { runId } = await params;

  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      experienceId: true,
      legs: { orderBy: { ordinal: 'desc' }, take: 1, select: { sessionId: true, status: true } },
    },
  });
  if (!run) {
    throw new NotFoundError('Run not found');
  }

  const newest = run.legs[0];
  if (!newest) {
    return errorResponse('This run has no legs to advance from', {
      code: 'NO_LEGS',
      status: 409,
    });
  }

  const result = await advanceExperienceRun(runId, newest.sessionId);

  logAdminAction({
    userId: session.user.id,
    action: 'app_experience_run.advance',
    entityType: 'app_experience_run',
    entityId: runId,
    metadata: { experienceId: run.experienceId, outcome: result.kind },
    clientIp,
  });
  log.info('Experience run advanced manually', { runId, outcome: result.kind });

  if (result.kind === 'blocked') {
    return errorResponse(result.message, { code: result.code, status: 409 });
  }
  return successResponse(result);
});

export const POST = handleAdvance;
