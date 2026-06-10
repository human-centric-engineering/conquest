/**
 * Data-slot collection — Data Slots feature.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/data-slots
 *   Admin-only: list the version's saved data slots (with their mapped question keys).
 *
 * PUT /api/v1/app/questionnaires/:id/versions/:vid/data-slots
 *   Admin-only: replace the version's data slots with the reviewed/accepted set. Forks a new
 *   draft first if the target is launched (editable id returned in `meta`). Gated by the
 *   master flag AND the data-slots sub-flag.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import {
  isDataSlotsEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { saveDataSlotsSchema } from '@/lib/app/questionnaire/data-slots';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadDataSlots,
  replaceDataSlots,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    if (!(await isDataSlotsEnabled())) {
      throw new NotFoundError('Data slots are not enabled');
    }
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }
    return successResponse({ slots: await loadDataSlots(vid) });
  }
);

const handleSave = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    if (!(await isDataSlotsEnabled())) {
      throw new NotFoundError('Data slots are not enabled');
    }

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, saveDataSlotsSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const slots = await replaceDataSlots(editId, body.slots);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_data_slots.save',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: { questionnaireId: id, versionId: editId, slotCount: slots.length },
      clientIp,
    });
    log.info('Data slots saved', { versionId: editId, slotCount: slots.length });

    return successResponse({ slots }, forkMeta(fork));
  }
);

export const GET = withQuestionnairesEnabled(handleList);
export const PUT = withQuestionnairesEnabled(handleSave);
