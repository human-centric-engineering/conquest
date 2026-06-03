/**
 * Tag vocabulary collection endpoint (F2.2).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/tags
 *   Admin-only: add a tag to a version's vocabulary. Forks a new draft first if the
 *   target is launched (editable id returned in `meta`). The normalised label is
 *   the case-insensitive dedup key — a duplicate surfaces as a 400.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { createTagSchema, normalizeTagLabel } from '@/lib/app/questionnaire/tagging';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  assertTagLabelAvailable,
  asTagConflict,
  TAG_SELECT,
} from '@/app/api/v1/app/questionnaires/_lib/tagging-routes';

const handleCreateTag = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, createTagSchema);

    // Reject a duplicate label before forking, so a doomed create on a launched
    // version doesn't leave an orphan draft (asTagConflict is the race backstop).
    await assertTagLabelAvailable(vid, body.label);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    try {
      const tag = await prisma.appQuestionTag.create({
        data: {
          versionId: editId,
          label: body.label,
          normalizedLabel: normalizeTagLabel(body.label),
          ...(body.color != null ? { color: body.color } : {}),
        },
        select: TAG_SELECT,
      });

      logAdminAction({
        userId: session.user.id,
        action: 'questionnaire_tag.create',
        entityType: 'questionnaire_tag',
        entityId: tag.id,
        entityName: tag.label,
        metadata: { questionnaireId: id, versionId: editId },
        clientIp,
      });
      log.info('Questionnaire tag created', { versionId: editId, tagId: tag.id });

      return successResponse(tag, forkMeta(fork), { status: 201 });
    } catch (err) {
      asTagConflict(err);
    }
  }
);

export const POST = withQuestionnairesEnabled(handleCreateTag);
