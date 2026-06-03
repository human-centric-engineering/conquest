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
 * PATCH /api/v1/app/questionnaires/:id  (DEMO-ONLY, F2.5.1)
 *   Attribute the questionnaire to a demo client (or detach with `null`). The only
 *   questionnaire-level mutation today; section/question/version edits live on the
 *   version path. Audited as `questionnaire.assign_demo_client`. A real client
 *   engagement strips demo tenancy — see forking.md § "Replacing demo tenancy".
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import {
  ensureQuestionnairesEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  assignDemoClientSchema,
  type AttributedDemoClient,
} from '@/lib/app/questionnaire/demo-clients';
import { getQuestionnaireDetail } from '@/app/api/v1/app/questionnaires/_lib/detail';

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

// DEMO-ONLY (F2.5.1): attribute the questionnaire to a demo client (or detach).
const handleAttribute = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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

  const body = await validateRequestBody(request, assignDemoClientSchema);

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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Flag gate first — a switched-off app is indistinguishable from a missing route.
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleDetail(request, context);
}

export const PATCH = withQuestionnairesEnabled(handleAttribute);
