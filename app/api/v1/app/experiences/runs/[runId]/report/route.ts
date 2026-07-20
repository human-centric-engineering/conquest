/**
 * Run-level respondent report — respondent-facing status + content (F15.4b).
 *
 * GET /api/v1/app/experiences/runs/:runId/report
 *   The journey's summary: what the `conclude` path has promised since F15.2. Serves both
 *   respondent kinds via the shared `canReadRun` gate — the run cookie on the no-login surface,
 *   session ownership on the authenticated one. The completion screen polls this until the status
 *   is terminal.
 *
 * **The admin bypass does not apply**, exactly as on the stitched-transcript route: a report is a
 * narrative about a specific person built from their answers, and an admin reading one belongs on
 * the audited admin surface rather than behind a respondent-shaped endpoint.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { runPollLimiter } from '@/app/api/v1/app/experiences/_lib/rate-limit';
import { buildRunReportClientView } from '@/lib/app/questionnaire/report/run-view';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { runId } = await params;

    // The completion screen polls this on the same cadence as the run-status endpoint, so it
    // shares that endpoint's generous sub-cap rather than a tighter one that would throttle the
    // happy path.
    const limit = runPollLimiter.check(getClientIP(request));
    if (!limit.success) return createRateLimitResponse(limit);

    const access = await canReadRun(request, runId);
    // 404 rather than 403: a caller who cannot prove ownership should not learn the run exists.
    if (!access.allowed || access.isAdmin) {
      return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });
    }

    const view = await buildRunReportClientView(runId);
    if (!view) return errorResponse('Run not found', { code: 'NOT_FOUND', status: 404 });

    log.debug('Run report read', { runId, status: view.insights?.status ?? 'n/a' });
    return successResponse(view);
  } catch (err) {
    return handleAPIError(err);
  }
}
