/**
 * Questionnaire detail endpoint (P2 / F2.1a).
 *
 * GET /api/v1/app/questionnaires/:id
 *   Admin-only read of one questionnaire plus a newest-first summary of each of
 *   its versions (status, goal/audience, section/question/change counts). 404 when
 *   the id is unknown — and, like every `/api/v1/app/**` route, 404 when the
 *   feature flag is off. Read model: `_lib/detail.ts`. Edit affordances arrive in
 *   F2.1b (PR2).
 *
 * PATCH /api/v1/app/questionnaires/:id
 *   Two questionnaire-level mutations, discriminated by the body:
 *     • `{ title }`        — rename the questionnaire (audited `questionnaire.rename`).
 *     • `{ demoClientId }` — DEMO-ONLY (F2.5.1) demo-client attribution / detach with
 *       `null` (audited `questionnaire.assign_demo_client`; a real client engagement
 *       strips demo tenancy — see forking.md § "Replacing demo tenancy").
 *   Section/question/version edits live on the version path.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import {
  assignDemoClientSchema,
  type AttributedDemoClient,
} from '@/lib/app/questionnaire/demo-clients';
import { renameQuestionnaireSchema } from '@/lib/app/questionnaire/title';
import { getQuestionnaireDetail } from '@/app/api/v1/app/questionnaires/_lib/detail';

// The PATCH body is one of two questionnaire-level mutations, told apart by which
// key is present: a rename (`{ title }`) or a demo-client attribution (`{ demoClientId }`).
const patchQuestionnaireSchema = renameQuestionnaireSchema.or(assignDemoClientSchema);

const handleDetail = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const detail = await getQuestionnaireDetail(id);
  if (!detail) {
    return errorResponse('Questionnaire not found', { code: 'NOT_FOUND', status: 404 });
  }

  log.info('Questionnaire detail read', {
    questionnaireId: id,
    versionCount: detail.versions.length,
  });
  return successResponse(detail);
});

// Questionnaire-level mutation: rename (real capability) or demo-client attribution
// (DEMO-ONLY, F2.5.1), discriminated by the validated body.
const handlePatch = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appQuestionnaire.findUnique({
    where: { id },
    select: { id: true, title: true, demoClientId: true },
  });
  if (!before) {
    throw new NotFoundError('Questionnaire not found');
  }

  const body = await validateRequestBody(request, patchQuestionnaireSchema);

  // Rename: a plain title change. No-op (same title) skips the write + audit but
  // still 200s so the form treats an unchanged save as success.
  if ('title' in body) {
    if (body.title !== before.title) {
      await prisma.appQuestionnaire.update({
        where: { id },
        data: { title: body.title },
        select: { id: true },
      });
      logAdminAction({
        userId: session.user.id,
        action: 'questionnaire.rename',
        entityType: 'questionnaire',
        entityId: id,
        entityName: body.title,
        changes: computeChanges({ title: before.title }, { title: body.title }),
        clientIp,
      });
      log.info('Questionnaire renamed', { questionnaireId: id });
    }
    return successResponse({ id, title: body.title });
  }

  // When attaching, the target client must exist. A dangling FK would be rejected
  // by the DB (P2003); pre-check for a clean 404 rather than a 500. Select the
  // summary fields so the response can echo the new attribution without a re-read.
  let attached: AttributedDemoClient | null = null;
  if (body.demoClientId !== null) {
    attached = await prisma.appDemoClient.findUnique({
      where: { id: body.demoClientId },
      select: { id: true, slug: true, name: true },
    });
    if (!attached) {
      return errorResponse('Demo client not found', { code: 'DEMO_CLIENT_NOT_FOUND', status: 404 });
    }
  }

  await prisma.appQuestionnaire.update({
    where: { id },
    data: { demoClientId: body.demoClientId },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire.assign_demo_client',
    entityType: 'questionnaire',
    entityId: id,
    entityName: before.title,
    changes: computeChanges(
      { demoClientId: before.demoClientId },
      { demoClientId: body.demoClientId }
    ),
    clientIp,
  });
  log.info('Questionnaire demo client attribution updated', {
    questionnaireId: id,
    demoClientId: body.demoClientId,
  });

  // Return only the changed attribution — the client refetches the page (router.refresh)
  // for the rest, so recomputing the full detail graph (findUnique + 3 groupBy) here is wasted.
  return successResponse({ id, demoClient: attached });
});

export const GET = handleDetail;

export const PATCH = handlePatch;
