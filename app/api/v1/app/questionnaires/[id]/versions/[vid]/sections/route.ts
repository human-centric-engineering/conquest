/**
 * Questionnaire section collection endpoint (F2.1 / PR2).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/sections
 *   Admin-only: add a section to a version. Forks a new draft first if the target
 *   is launched (editable id returned in `meta`). `ordinal` defaults to append.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createSectionSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

const handleCreateSection = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, createSectionSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const ordinal =
      body.ordinal ??
      (await prisma.appQuestionnaireSection.count({ where: { versionId: editId } }));

    const section = await prisma.appQuestionnaireSection.create({
      data: {
        versionId: editId,
        ordinal,
        title: body.title,
        ...(body.description != null ? { description: body.description } : {}),
      },
      select: { id: true, ordinal: true, title: true, description: true },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_section.create',
      entityType: 'questionnaire_section',
      entityId: section.id,
      entityName: section.title,
      metadata: { questionnaireId: id, versionId: editId },
      clientIp,
    });
    log.info('Questionnaire section created', { versionId: editId, sectionId: section.id });

    return successResponse(section, forkMeta(fork), { status: 201 });
  }
);

export const POST = handleCreateSection;
