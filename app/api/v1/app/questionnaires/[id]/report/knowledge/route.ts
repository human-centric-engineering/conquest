/**
 * Respondent Report — client knowledge base (list).
 *
 * GET /api/v1/app/questionnaires/:id/report/knowledge
 *   Admin-only. Returns the questionnaire's attributed client's private knowledge corpus — the
 *   documents carrying the client's dedicated tag — plus the tag id the Generation-tab uploader
 *   stamps onto new uploads. Ensures the client's tag exists (idempotent) so the uploader always has
 *   an id to apply. Returns `client: null` when the questionnaire has no attributed demo client
 *   (there is no per-client corpus to scope to).
 *
 *   This is the app-side, client-scoped read that keeps the embedded KB UI isolated to one client —
 *   we never call the platform's global documents list (which would show every client's docs). Upload
 *   + per-document detail still use the platform endpoints; only the scoped LIST lives here.
 */

import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getClientKnowledgeViewForQuestionnaire } from '@/lib/app/questionnaire/report/client-knowledge';

const handleGet = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const exists = await prisma.appQuestionnaire.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError('Questionnaire not found');

  const view = await getClientKnowledgeViewForQuestionnaire(id);
  log.info('Resolved client knowledge view', {
    questionnaireId: id,
    clientId: view.client?.id ?? null,
    documentCount: view.documents.length,
  });

  return successResponse(view);
});

export const GET = withQuestionnairesEnabled(handleGet);
