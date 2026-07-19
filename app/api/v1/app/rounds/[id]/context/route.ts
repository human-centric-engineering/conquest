/**
 * Round Additional Context ("interviewer briefing") collection endpoint.
 *
 * GET  /api/v1/app/rounds/:id/context        — list briefing entries (optional ?versionId= filter).
 * POST /api/v1/app/rounds/:id/context        — create a briefing entry (general or question-attributed).
 *
 * All: `withAdminAuth`, then 404 on unknown round. The version must be one the round bundles, and an
 * attributed `questionSlotId` must belong to that version (else 400). Audited.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createRoundContextEntrySchema } from '@/lib/app/questionnaire/rounds';
import {
  assertRoundBundlesVersion,
  assertSlotInVersion,
  getRoundContextEntry,
  listRoundContextEntries,
} from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string };

const handleList = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const versionId = new URL(request.url).searchParams.get('versionId') ?? undefined;
  const entries = await listRoundContextEntries(id, versionId);

  log.info('Round context entries listed', { id, count: entries.length });
  return successResponse({ entries });
});

const handleCreate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const body = await validateRequestBody(request, createRoundContextEntrySchema);

  // The version must be one the round actually bundles — a briefing can't target a version outside it.
  if (!(await assertRoundBundlesVersion(id, body.versionId))) {
    return errorResponse('That version is not part of this round', {
      code: 'VERSION_NOT_IN_ROUND',
      status: 400,
    });
  }
  // An attributed entry must point at a question that exists in the briefed version.
  if (body.questionSlotId && !(await assertSlotInVersion(body.versionId, body.questionSlotId))) {
    return errorResponse('That question does not belong to this version', {
      code: 'QUESTION_NOT_IN_VERSION',
      status: 400,
    });
  }

  const created = await prisma.appRoundContextEntry.create({
    data: {
      roundId: id,
      versionId: body.versionId,
      questionSlotId: body.questionSlotId ?? null,
      title: body.title,
      content: body.content,
      source: body.source ?? 'manual',
      ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      createdBy: session.user.id,
    },
    select: { id: true },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.context_entry.create',
    entityType: 'app_round_context_entry',
    entityId: created.id,
    entityName: body.title,
    metadata: {
      roundId: id,
      versionId: body.versionId,
      questionSlotId: body.questionSlotId ?? null,
      source: body.source ?? 'manual',
    },
    clientIp,
  });
  log.info('Round context entry created', { id, entryId: created.id });

  const entry = await getRoundContextEntry(id, created.id);
  return successResponse(entry, undefined, { status: 201 });
});

export const GET = handleList;
export const POST = handleCreate;
