/**
 * Single-section endpoint (F2.1 / PR2).
 *
 * PATCH  …/versions/:vid/sections/:sectionId — edit title/description.
 * DELETE …/versions/:vid/sections/:sectionId — remove the section (cascades its
 *   questions). Both fork a launched version first and retarget the section id
 *   through the fork map.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateSectionSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  forkMeta,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

const SECTION_SELECT = { id: true, ordinal: true, title: true, description: true } as const;

type Params = { id: string; vid: string; sectionId: string };

/** Load a section scoped to the version, or `null` (→ 404). */
async function scopedSection(versionId: string, sectionId: string) {
  return prisma.appQuestionnaireSection.findFirst({
    where: { id: sectionId, versionId },
    select: SECTION_SELECT,
  });
}

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, sectionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await scopedSection(vid, sectionId);
  if (!existing) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const body = await validateRequestBody(request, updateSectionSchema);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetId = resolveForkedId(fork, 'section', sectionId);
  if (!targetId) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const data: Prisma.AppQuestionnaireSectionUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;

  const updated = await prisma.appQuestionnaireSection.update({
    where: { id: targetId },
    data,
    select: SECTION_SELECT,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_section.update',
    entityType: 'questionnaire_section',
    entityId: targetId,
    entityName: updated.title,
    changes: computeChanges(existing, updated, { ignoreKeys: ['id'] }),
    clientIp,
  });
  log.info('Questionnaire section updated', { versionId: fork.versionId, sectionId: targetId });

  return successResponse(updated, forkMeta(fork));
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, sectionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await scopedSection(vid, sectionId);
  if (!existing) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetId = resolveForkedId(fork, 'section', sectionId);
  if (!targetId) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  // FK is onDelete: Cascade — removing a section removes its questions.
  await prisma.appQuestionnaireSection.delete({ where: { id: targetId } });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_section.delete',
    entityType: 'questionnaire_section',
    entityId: targetId,
    entityName: existing.title,
    metadata: { questionnaireId: id, versionId: fork.versionId },
    clientIp,
  });
  log.info('Questionnaire section deleted', { versionId: fork.versionId, sectionId: targetId });

  return successResponse({ id: targetId, deleted: true }, forkMeta(fork));
});

export const PATCH = withQuestionnairesEnabled(handlePatch);

export const DELETE = withQuestionnairesEnabled(handleDelete);
