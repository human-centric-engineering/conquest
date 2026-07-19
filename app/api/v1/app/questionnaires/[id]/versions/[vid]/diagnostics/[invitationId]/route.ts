/**
 * Per-invitation diagnostics — drill-down (Diagnostics).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/diagnostics/:invitationId
 *   Admin-only. One invitation's lifecycle, every session it produced with the full per-turn
 *   telemetry timeline (including the raw inspector calls for the deep-dive), and its captured
 *   errors. 404s when the invitation doesn't belong to the scoped version. Read-only and
 *   version-scoped.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';

import { getInvitationDiagnostics } from '@/lib/app/questionnaire/analytics';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

const handleGet = withAdminAuth<{ id: string; vid: string; invitationId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, invitationId } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const result = await getInvitationDiagnostics(vid, invitationId);
    if (!result) {
      return errorResponse('Invitation not found for this version', {
        code: 'NOT_FOUND',
        status: 404,
      });
    }

    log.info('Invitation diagnostics computed', {
      versionId: vid,
      invitationId,
      sessions: result.sessions.length,
      errorCount: result.errors.length,
    });

    return successResponse(result);
  }
);

export const GET = handleGet;
