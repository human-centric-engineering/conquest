/**
 * Round Additional Context ("interviewer briefing") single-entry endpoint.
 *
 * PATCH  /api/v1/app/rounds/:id/context/:entryId  — re-attribute / retitle / rewrite / reorder.
 * DELETE /api/v1/app/rounds/:id/context/:entryId  — remove a briefing entry.
 *
 * All: round-context flag-gate first (404 when off), then `withAdminAuth`, then 404 when the entry
 * isn't found within the round. A re-attribution (`questionSlotId`) must point at a question in the
 * entry's version (else 400). Audited.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withRoundContextEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateRoundContextEntrySchema } from '@/lib/app/questionnaire/rounds';
import { assertSlotInVersion, getRoundContextEntry } from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string; entryId: string };

const handleUpdate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, entryId } = await params;

  const before = await prisma.appRoundContextEntry.findFirst({
    where: { id: entryId, roundId: id },
    select: {
      id: true,
      versionId: true,
      questionSlotId: true,
      title: true,
      content: true,
      ordinal: true,
    },
  });
  if (!before) throw new NotFoundError('Context entry not found');

  const body = await validateRequestBody(request, updateRoundContextEntrySchema);

  // A re-attribution must land on a question that exists in the entry's (immutable) version. A null
  // questionSlotId is always allowed — it makes the entry general again.
  if (
    body.questionSlotId !== undefined &&
    body.questionSlotId !== null &&
    !(await assertSlotInVersion(before.versionId, body.questionSlotId))
  ) {
    return errorResponse('That question does not belong to this version', {
      code: 'QUESTION_NOT_IN_VERSION',
      status: 400,
    });
  }

  const updated = await prisma.appRoundContextEntry.update({
    where: { id: entryId },
    data: {
      ...(body.questionSlotId !== undefined ? { questionSlotId: body.questionSlotId } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
    },
    select: {
      id: true,
      versionId: true,
      questionSlotId: true,
      title: true,
      content: true,
      ordinal: true,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.context_entry.update',
    entityType: 'app_round_context_entry',
    entityId: entryId,
    entityName: updated.title,
    changes: computeChanges(before, updated),
    clientIp,
  });
  log.info('Round context entry updated', { id, entryId });

  const entry = await getRoundContextEntry(id, entryId);
  return successResponse(entry);
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, entryId } = await params;

  const entry = await prisma.appRoundContextEntry.findFirst({
    where: { id: entryId, roundId: id },
    select: { id: true, title: true },
  });
  if (!entry) throw new NotFoundError('Context entry not found');

  await prisma.appRoundContextEntry.delete({ where: { id: entryId } });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.context_entry.delete',
    entityType: 'app_round_context_entry',
    entityId: entryId,
    entityName: entry.title,
    clientIp,
  });
  log.info('Round context entry deleted', { id, entryId });

  return successResponse({ id: entryId, deleted: true });
});

export const PATCH = withRoundContextEnabled(handleUpdate);
export const DELETE = withRoundContextEnabled(handleDelete);
