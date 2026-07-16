/**
 * Learning Mode — manual digest rebuild (round Learning Mode, phase 5).
 *
 * POST /api/v1/app/rounds/:id/learning/rebuild
 *   Admin-only. Rebuilds this round's peer-theme digest for every bundled version — the operator
 *   remedy after toggling Learning Mode on, changing the threshold, or a respondent erasure. Returns
 *   a per-version build summary. The build itself re-checks the per-round toggle + k-anonymity and is
 *   fully fail-soft.
 *
 * Pipeline: learning-mode flag-gate (404 when off) → withAdminAuth → 404 on unknown round →
 *   resolve bundled versions → refresh each → summary.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { refreshRoundLearningDigest } from '@/lib/app/questionnaire/learning/digest';
import { listBriefableQuestionnaires } from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string };

const handleRebuild = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id: roundId } = await params;

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { id: true, name: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  // Rebuild once per bundled version (each resolves to its effective pinned/launched version).
  const briefable = await listBriefableQuestionnaires(roundId);
  const versionIds = [...new Set(briefable.map((b) => b.versionId))];
  const results = await Promise.all(
    versionIds.map(async (versionId) => ({
      versionId,
      ...(await refreshRoundLearningDigest(roundId, versionId)),
    }))
  );
  const builtCount = results.filter((r) => r.built).length;

  logAdminAction({
    userId: session.user.id,
    action: 'app_round.learning_rebuild',
    entityType: 'app_questionnaire_round',
    entityId: roundId,
    entityName: round.name,
    metadata: { versions: versionIds.length, built: builtCount },
    clientIp,
  });
  log.info('Round learning digest rebuilt', { roundId, versions: versionIds.length, builtCount });

  return successResponse({ versions: results });
});

export const POST = handleRebuild;
