/**
 * Per-version restore endpoint — the inverse of the soft-archive.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/restore
 *   Clear the version's `archivedAt`, returning it to the default admin version list in its
 *   exact prior state (archiving never touched `status`, sessions, or any other row — only
 *   the marker). Idempotent: restoring an already-active version 200s with no write/audit.
 *   Audited `questionnaire_version.restore`. See .context/app/questionnaire/archiving.md.
 *
 * Pipeline: withAdminAuth → scope-load (404) → clear marker → admin audit → 200 `{ id,
 * archivedAt }`. Auth: admin only. No sub-cap — the 100/min section cap suffices.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { setVersionArchived } from '@/app/api/v1/app/questionnaires/_lib/version-archive';

const handleRestore = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const result = await setVersionArchived(vid, false, { userId: session.user.id, clientIp });
    if (!result) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    log.info('Questionnaire version restored', { questionnaireId: id, versionId: vid });
    return successResponse(result);
  }
);

export const POST = handleRestore;
