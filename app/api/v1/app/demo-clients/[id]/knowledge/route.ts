/**
 * Demo client — private knowledge base (list).
 *
 * GET /api/v1/app/demo-clients/:id/knowledge
 *   Admin-only. Returns the client's private knowledge corpus — the documents carrying the client's
 *   dedicated tag — plus the tag id the KB panel stamps onto new uploads. Ensures the client's tag
 *   exists (idempotent) so the uploader always has an id to apply.
 *
 *   The corpus belongs to the client (shared across all its questionnaires), so this is the canonical
 *   client-scoped read behind the demo-client page's Knowledge base panel. We never call the
 *   platform's global documents list (which would show every client's docs); upload + per-document
 *   detail still use the platform endpoints, only the scoped LIST lives here.
 *
 *   Gate order mirrors the other demo-client routes: flag-gate first (404 when off), then
 *   `withAdminAuth`, then 404 on an unknown id.
 */

import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getClientKnowledgeViewForClient } from '@/lib/app/questionnaire/report/client-knowledge';

const handleGet = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const exists = await prisma.appDemoClient.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError('Demo client not found');

  const view = await getClientKnowledgeViewForClient(id);
  log.info('Resolved client knowledge view', {
    clientId: id,
    documentCount: view.documents.length,
  });

  return successResponse(view);
});

export const GET = withQuestionnairesEnabled(handleGet);
