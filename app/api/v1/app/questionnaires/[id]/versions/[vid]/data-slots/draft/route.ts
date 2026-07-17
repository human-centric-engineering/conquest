/**
 * Data-slot DRAFT proposal — Data Slots feature.
 *
 * DELETE /api/v1/app/questionnaires/:id/versions/:vid/data-slots/draft
 *   Admin-only: discard the version's pending generated data-slot proposal (the draft the
 *   admin generated but never saved). The saved/live set (AppDataSlot) is untouched. Gated by
 *   the master flag AND the data-slots sub-flag. Idempotent — discarding when there is no
 *   draft is a no-op success.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { deleteDataSlotDraft } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';

const handleDiscard = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    await deleteDataSlotDraft(vid);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_data_slots.discard_draft',
      entityType: 'questionnaire_version',
      entityId: vid,
      metadata: { questionnaireId: id, versionId: vid },
      clientIp,
    });
    log.info('Data-slot draft discarded', { versionId: vid });

    return successResponse({ discarded: true });
  }
);

export const DELETE = handleDiscard;
