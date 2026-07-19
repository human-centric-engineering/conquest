/**
 * Restore endpoint — the inverse of the soft-delete archive.
 *
 * POST /api/v1/app/questionnaires/:id/restore
 *   Clears `archivedAt`, returning an archived questionnaire to the active list in
 *   its exact prior state (archiving never touched `status`, versions, sessions, or
 *   any other row — only the marker). Idempotent: restoring an already-active
 *   questionnaire 200s without a write or a duplicate audit. Audited
 *   `questionnaire.restore`. See .context/app/questionnaire/archiving.md.
 *
 * Pipeline: withAdminAuth → load → (no-op if active) → clear marker →
 * admin audit → 200 `{ id }`. Auth: admin only. No sub-cap — the 100/min section
 * cap suffices (a single bounded UPDATE, no LLM call).
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const handleRestore = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const before = await prisma.appQuestionnaire.findUnique({
    where: { id },
    select: { id: true, title: true, archivedAt: true },
  });
  if (!before) {
    throw new NotFoundError('Questionnaire not found');
  }

  // Already active → idempotent success, no write/audit.
  if (!before.archivedAt) {
    return successResponse({ id });
  }

  await prisma.appQuestionnaire.update({
    where: { id },
    data: { archivedAt: null },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire.restore',
    entityType: 'questionnaire',
    entityId: id,
    entityName: before.title,
    clientIp,
  });
  log.info('Questionnaire restored', { questionnaireId: id });

  return successResponse({ id });
});

export const POST = handleRestore;
