/**
 * Per-version soft-archive endpoint.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/archive
 *   Stamp the version's `archivedAt` so it drops out of the default admin version list
 *   (selector + history) while staying fully recoverable (POST …/restore clears it).
 *   ORTHOGONAL to `status` — the version's lifecycle and any in-flight respondent sessions
 *   pinned to it are untouched (this is NOT the terminal `status: 'archived'` transition).
 *   Idempotent: archiving an already-archived version 200s with no write/audit. Audited
 *   `questionnaire_version.archive`. See .context/app/questionnaire/archiving.md.
 *
 * Pipeline: withAdminAuth → scope-load (404) → set marker → admin audit → 200 `{ id,
 * archivedAt }`. Auth: admin only. No sub-cap — the 100/min section cap suffices (a single
 * bounded UPDATE, no LLM call).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { setVersionArchived } from '@/app/api/v1/app/questionnaires/_lib/version-archive';

const handleArchive = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const result = await setVersionArchived(vid, true, { userId: session.user.id, clientIp });
    // Scope-load already proved the row exists; a null here would only mean a concurrent delete.
    if (!result) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    log.info('Questionnaire version archived', { questionnaireId: id, versionId: vid });
    return successResponse(result);
  }
);

export const POST = handleArchive;
