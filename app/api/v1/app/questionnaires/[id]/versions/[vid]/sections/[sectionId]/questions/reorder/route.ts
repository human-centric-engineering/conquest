/**
 * Question reorder endpoint (F2.1 / PR2).
 *
 * PATCH …/versions/:vid/sections/:sectionId/questions/reorder
 *   Admin-only: set the full new order of a section's questions (`{ order: [id…] }`,
 *   a permutation of that section's current question ids). Forks a launched version
 *   first, remapping section + question ids through the fork. Intra-section only —
 *   moving a question across sections is a question PATCH (`sectionId`).
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { reorderSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  applyReorder,
  forkMeta,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Params = { id: string; vid: string; sectionId: string };

const handleReorderQuestions = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, sectionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const section = await prisma.appQuestionnaireSection.findFirst({
    where: { id: sectionId, versionId: vid },
    select: { id: true },
  });
  if (!section) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const { order } = await validateRequestBody(request, reorderSchema);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetSectionId = resolveForkedId(fork, 'section', sectionId);
  if (!targetSectionId)
    return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const mapped: string[] = [];
  for (const questionId of order) {
    const target = resolveForkedId(fork, 'question', questionId);
    if (!target) {
      throw new ValidationError('Reorder references a question not in this version', {
        order: ['Unknown question id'],
      });
    }
    mapped.push(target);
  }

  const current = await prisma.appQuestionSlot.findMany({
    where: { sectionId: targetSectionId },
    select: { id: true },
  });

  await executeTransaction((tx) =>
    applyReorder(
      current.map((q) => q.id),
      mapped,
      (questionId, ordinal) =>
        tx.appQuestionSlot.update({ where: { id: questionId }, data: { ordinal } })
    )
  );

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_question.reorder',
    entityType: 'questionnaire_section',
    entityId: targetSectionId,
    metadata: { questionnaireId: id, versionId: fork.versionId, order: mapped },
    clientIp,
  });
  log.info('Questionnaire questions reordered', {
    sectionId: targetSectionId,
    count: mapped.length,
  });

  return successResponse({ order: mapped }, forkMeta(fork));
});

export const PATCH = withQuestionnairesEnabled(handleReorderQuestions);
