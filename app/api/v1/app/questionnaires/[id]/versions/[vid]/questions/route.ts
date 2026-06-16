/**
 * Version-question collection endpoint (bulk requiredness).
 *
 * PATCH …/versions/:vid/questions — bulk-set every question's `required` flag in
 *   the version (the Structure editor's "All questions required" tri-state
 *   checkbox). Body: `{ required: boolean }`. All-or-nothing, no per-question
 *   targeting — for a single question use `…/questions/:questionId`.
 *
 * Like every authoring mutation it forks a launched version first (so in-flight
 * work stays pinned to the version it started on) and writes to the fork; the
 * success `meta` carries the fork outcome so the editor can notice + redirect.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { bulkSetRequiredSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Params = { id: string; vid: string };

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const { required } = await validateRequestBody(request, bulkSetRequiredSchema);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;

  const { count } = await prisma.appQuestionSlot.updateMany({
    where: { versionId: editId },
    data: { required },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_question.bulk_required',
    entityType: 'questionnaire_version',
    entityId: editId,
    metadata: { questionnaireId: id, versionId: editId, required, updated: count },
    clientIp,
  });
  log.info('Questionnaire questions bulk requiredness set', {
    versionId: editId,
    required,
    updated: count,
  });

  return successResponse({ updated: count, required }, forkMeta(fork));
});

export const PATCH = withQuestionnairesEnabled(handlePatch);
