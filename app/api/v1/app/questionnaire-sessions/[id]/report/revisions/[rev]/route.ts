/**
 * Respondent Report re-run — one revision's full content (admin viewer).
 *
 * GET /api/v1/app/questionnaire-sessions/:id/report/revisions/:rev
 *   Admin-only. The full generated content of re-run revision `:rev` for the session, so the viewer's
 *   "View" dialog can render it with the same paper renderer respondents see. 404 when the revision
 *   doesn't exist.
 *
 *   Gate order: master flag → respondent-report flag (404 before auth) → withAdminAuth → load.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { withAdminAuth } from '@/lib/auth/guards';

import { getRespondentReportRevisionDetail } from '@/lib/app/questionnaire/report/revision';

const handleGet = withAdminAuth<{ id: string; rev: string }>(
  async (_request, _session, { params }) => {
    const { id: sessionId, rev } = await params;

    // Strict digits-only parse — `Number.parseInt('2abc')` would otherwise coerce to 2 and quietly
    // resolve the wrong revision.
    if (!/^\d+$/.test(rev)) {
      return errorResponse('Invalid revision number', { code: 'BAD_REQUEST', status: 400 });
    }
    // Revision 0 is the immutable "Original" baseline (the submit-time generation), so 0 is valid.
    const revisionNumber = Number.parseInt(rev, 10);
    if (revisionNumber < 0) {
      return errorResponse('Invalid revision number', { code: 'BAD_REQUEST', status: 400 });
    }

    const detail = await getRespondentReportRevisionDetail(sessionId, revisionNumber);
    if (!detail) return errorResponse('Revision not found', { code: 'NOT_FOUND', status: 404 });

    return successResponse(detail);
  }
);

export const GET = handleGet;
