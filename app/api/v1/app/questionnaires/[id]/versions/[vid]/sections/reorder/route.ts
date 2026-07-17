/**
 * Section reorder endpoint (F2.1 / PR2).
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/sections/reorder
 *   Admin-only: set the full new order of a version's sections (`{ order: [id…] }`,
 *   a permutation of the current section ids). Forks a launched version first,
 *   remapping the order through the fork. Rewrites ordinals 0..n-1 in one tx.
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

import { reorderSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  applyReorder,
  forkMeta,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

const handleReorderSections = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const { order } = await validateRequestBody(request, reorderSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    // Remap the requested order through the fork (URL ids are the original version's).
    const mapped: string[] = [];
    for (const sectionId of order) {
      const target = resolveForkedId(fork, 'section', sectionId);
      if (!target) {
        throw new ValidationError('Reorder references a section not in this version', {
          order: ['Unknown section id'],
        });
      }
      mapped.push(target);
    }

    const current = await prisma.appQuestionnaireSection.findMany({
      where: { versionId: editId },
      select: { id: true },
    });

    await executeTransaction((tx) =>
      applyReorder(
        current.map((s) => s.id),
        mapped,
        (sectionId, ordinal) =>
          tx.appQuestionnaireSection.update({ where: { id: sectionId }, data: { ordinal } })
      )
    );

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_section.reorder',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: { questionnaireId: id, versionId: editId, order: mapped },
      clientIp,
    });
    log.info('Questionnaire sections reordered', { versionId: editId, count: mapped.length });

    return successResponse({ order: mapped }, forkMeta(fork));
  }
);

export const PATCH = handleReorderSections;
