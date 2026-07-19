/**
 * Respondent Report re-run — promote a revision into the delivered report (admin).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/report/revisions/:rev/promote
 *   Admin-only. Copies a `ready` re-run revision's content onto the delivered `AppRespondentReport`, so
 *   the respondent's on-screen report + downloadable PDF now render this re-run. A no-op 409 when the
 *   revision isn't `ready` (nothing to promote). Cheap (a DB copy) — inherits the section rate cap.
 *
 *   Gate order: withAdminAuth → promote.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { promoteRespondentReportRevision } from '@/lib/app/questionnaire/report/revision';

const handlePromote = withAdminAuth<{ id: string; rev: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: sessionId, rev } = await params;

    // Strict digits-only parse — `Number.parseInt('2abc')` would otherwise coerce to 2 and quietly
    // promote the wrong revision.
    if (!/^\d+$/.test(rev)) {
      return errorResponse('Invalid revision number', { code: 'BAD_REQUEST', status: 400 });
    }
    // Revision 0 is the "Original" baseline; promoting it is how "Revert to original" restores the
    // respondent-facing report, so 0 is valid.
    const revisionNumber = Number.parseInt(rev, 10);
    if (revisionNumber < 0) {
      return errorResponse('Invalid revision number', { code: 'BAD_REQUEST', status: 400 });
    }

    const { promoted } = await promoteRespondentReportRevision({ sessionId, revisionNumber });
    if (!promoted) {
      return errorResponse('That revision cannot be promoted — it is not ready yet.', {
        code: 'REPORT_REVISION_NOT_READY',
        status: 409,
      });
    }

    log.info('Report revision promoted to delivered report', {
      adminId: session.user.id,
      sessionId,
      revisionNumber,
    });
    return successResponse({ promoted: true });
  }
);

export const POST = handlePromote;
