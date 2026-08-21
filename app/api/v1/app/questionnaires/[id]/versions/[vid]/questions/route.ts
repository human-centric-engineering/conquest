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

import { bulkUpdateQuestionsSchema } from '@/lib/app/questionnaire/authoring';
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

  const { required, fidelity, sectionId } = await validateRequestBody(
    request,
    bulkUpdateQuestionsSchema
  );

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;

  // A fork mints new section rows, so a `sectionId` naming a section on the LAUNCHED version would
  // match nothing and silently update zero questions. Resolve it by `ordinal` onto the edit version.
  let editSectionId = sectionId;
  if (sectionId !== undefined && fork.versionId !== scoped.id) {
    const source = await prisma.appQuestionnaireSection.findFirst({
      where: { id: sectionId, versionId: scoped.id },
      select: { ordinal: true },
    });
    if (!source)
      return errorResponse('Section not found in this version', { code: 'NOT_FOUND', status: 404 });
    const copied = await prisma.appQuestionnaireSection.findFirst({
      where: { versionId: editId, ordinal: source.ordinal },
      select: { id: true },
    });
    if (!copied)
      return errorResponse('Section not found in this version', { code: 'NOT_FOUND', status: 404 });
    editSectionId = copied.id;
  } else if (sectionId !== undefined) {
    const owned = await prisma.appQuestionnaireSection.findFirst({
      where: { id: sectionId, versionId: editId },
      select: { id: true },
    });
    if (!owned)
      return errorResponse('Section not found in this version', { code: 'NOT_FOUND', status: 404 });
  }

  const { count } = await prisma.appQuestionSlot.updateMany({
    where: {
      versionId: editId,
      ...(editSectionId !== undefined ? { sectionId: editSectionId } : {}),
    },
    data: {
      ...(required !== undefined ? { required } : {}),
      ...(fidelity !== undefined ? { fidelity } : {}),
    },
  });

  // Keep the original action string for the original operation so existing audit history stays
  // queryable, and give fidelity its own rather than folding both under a vaguer name.
  const action =
    required !== undefined && fidelity !== undefined
      ? 'questionnaire_question.bulk_update'
      : fidelity !== undefined
        ? 'questionnaire_question.bulk_fidelity'
        : 'questionnaire_question.bulk_required';

  logAdminAction({
    userId: session.user.id,
    action,
    entityType: 'questionnaire_version',
    entityId: editId,
    metadata: {
      questionnaireId: id,
      versionId: editId,
      ...(required !== undefined ? { required } : {}),
      ...(fidelity !== undefined ? { fidelity } : {}),
      ...(editSectionId !== undefined ? { sectionId: editSectionId } : {}),
      updated: count,
    },
    clientIp,
  });
  log.info('Questionnaire questions bulk updated', {
    versionId: editId,
    ...(required !== undefined ? { required } : {}),
    ...(fidelity !== undefined ? { fidelity } : {}),
    updated: count,
  });

  return successResponse(
    {
      updated: count,
      ...(required !== undefined ? { required } : {}),
      ...(fidelity !== undefined ? { fidelity } : {}),
    },
    forkMeta(fork)
  );
});

export const PATCH = handlePatch;
