/**
 * Single-tag endpoint (F2.2).
 *
 * PATCH  …/versions/:vid/tags/:tagId — rename and/or recolour.
 * DELETE …/versions/:vid/tags/:tagId — remove the tag (cascades its assignments).
 *   Both fork a launched version first and retarget the tag id through the fork map.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateTagSchema, normalizeTagLabel } from '@/lib/app/questionnaire/tagging';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  forkMeta,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  assertTagLabelAvailable,
  asTagConflict,
  loadScopedTag,
  TAG_SELECT,
} from '@/app/api/v1/app/questionnaires/_lib/tagging-routes';

type Params = { id: string; vid: string; tagId: string };

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, tagId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await loadScopedTag(vid, tagId);
  if (!existing) return errorResponse('Tag not found', { code: 'NOT_FOUND', status: 404 });

  const body = await validateRequestBody(request, updateTagSchema);

  // Reject a rename collision before forking (excluding this tag), so a doomed
  // rename on a launched version doesn't leave an orphan draft.
  if (body.label !== undefined) await assertTagLabelAvailable(vid, body.label, tagId);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetId = resolveForkedId(fork, 'tag', tagId);
  if (!targetId) return errorResponse('Tag not found', { code: 'NOT_FOUND', status: 404 });

  const data: Prisma.AppQuestionTagUpdateInput = {};
  if (body.label !== undefined) {
    data.label = body.label;
    data.normalizedLabel = normalizeTagLabel(body.label);
  }
  if (body.color !== undefined) data.color = body.color;

  try {
    const updated = await prisma.appQuestionTag.update({
      where: { id: targetId },
      data,
      select: TAG_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_tag.update',
      entityType: 'questionnaire_tag',
      entityId: targetId,
      entityName: updated.label,
      // normalizedLabel is the internal dedup key (moves in lockstep with label) —
      // omit it so the audit diff shows only the user-facing label/color change.
      changes: computeChanges(existing, updated, { ignoreKeys: ['id', 'normalizedLabel'] }),
      clientIp,
    });
    log.info('Questionnaire tag updated', { versionId: fork.versionId, tagId: targetId });

    return successResponse(updated, forkMeta(fork));
  } catch (err) {
    asTagConflict(err);
  }
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, tagId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await loadScopedTag(vid, tagId);
  if (!existing) return errorResponse('Tag not found', { code: 'NOT_FOUND', status: 404 });

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetId = resolveForkedId(fork, 'tag', tagId);
  if (!targetId) return errorResponse('Tag not found', { code: 'NOT_FOUND', status: 404 });

  // FK is onDelete: Cascade — removing a tag removes its question assignments.
  await prisma.appQuestionTag.delete({ where: { id: targetId } });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_tag.delete',
    entityType: 'questionnaire_tag',
    entityId: targetId,
    entityName: existing.label,
    metadata: { questionnaireId: id, versionId: fork.versionId },
    clientIp,
  });
  log.info('Questionnaire tag deleted', { versionId: fork.versionId, tagId: targetId });

  return successResponse({ id: targetId, deleted: true }, forkMeta(fork));
});

export const PATCH = handlePatch;

export const DELETE = handleDelete;
