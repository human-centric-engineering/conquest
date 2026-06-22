/**
 * Cohort Report — per-section AI-assist (report kind `cohort`, F14.5).
 *
 * POST /api/v1/app/rounds/:id/cohort-report/refine   body: { heading, body, instruction }
 *   Admin-only. Rewrites ONE section under a free-text instruction and returns the revised heading +
 *   HTML body (it does NOT persist — the editor drops it into the working draft, which the admin
 *   saves via PATCH). Paid LLM work → per-admin sub-cap. Gated by the cohort-report flag.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { refineCohortReportSection } from '@/lib/app/questionnaire/cohort-report';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

type Params = { id: string };

const bodySchema = z.object({
  heading: z.string().trim().max(200),
  body: z.string().max(8000),
  instruction: z.string().trim().min(1).max(1000),
});

const handleRefine = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const adminId = session.user.id;
  const { id: roundId } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { id: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Cohort-report refine rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const body = await validateRequestBody(request, bodySchema);

  try {
    const refined = await refineCohortReportSection(body);
    log.info('Cohort report section refined', { roundId });
    return successResponse(refined);
  } catch (err) {
    log.warn('Cohort-report refine failed', {
      roundId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Could not refine the section', { code: 'REFINE_FAILED', status: 502 });
  }
});

export const POST = withCohortReportEnabled(handleRefine);
