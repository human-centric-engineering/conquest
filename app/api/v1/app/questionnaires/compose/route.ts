/**
 * Generative-authoring compose endpoint (non-streaming).
 *
 * POST /api/v1/app/questionnaires/compose
 *   Admin-only. Composes a structured questionnaire (sections, questions with
 *   inferred types, inferred goal/audience) from a plain-English brief — no source
 *   document — and persists the whole graph in one transaction, exactly like the
 *   document-ingestion route but with the brief synthesized as the source
 *   provenance. Returns the new questionnaire/version ids and counts. This is the
 *   API-first surface; the admin UI uses the streaming sibling
 *   (`/compose/stream`) for the watch-it-build experience.
 *
 * Pipeline: flag-gate → withAdminAuth → per-admin sub-cap → JSON body parse →
 *   demo-client existence check → composer-agent load → capability dispatch →
 *   coherence check → transactional persist → admin audit → 201.
 *
 * Auth: admin only. Flag: 404 when the master OR generative-authoring sub-flag is
 * off. Rate limit: inherits the 100/min `api` section cap; adds a tighter per-admin
 * sub-cap because each compose is a 1+ reasoning LLM call.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  composeFromBrief,
  loadComposerAgent,
  type ComposeAdminMeta,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { persistIngestion, briefSource } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { composeRequestSchema } from '@/app/api/v1/app/questionnaires/_lib/compose-input';

/** Title for the composed questionnaire: admin name, else a trim of the inferred goal, else a default. */
function deriveComposeTitle(
  adminTitle: string | undefined,
  inferredGoal: string | undefined
): string {
  if (adminTitle && adminTitle.trim().length > 0) return adminTitle.trim();
  const goal = inferredGoal?.trim();
  if (goal) return goal.length > 80 ? `${goal.slice(0, 79)}…` : goal;
  return 'Untitled questionnaire';
}

const handleCompose = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIP = getClientIP(request);
  const adminId = session.user.id;

  // Per-admin sub-cap — each compose is an expensive 1+ LLM-call flow.
  const rl = composeLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Questionnaire compose rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const body = composeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return errorResponse('Invalid compose request', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { issues: body.error.issues },
    });
  }
  const { brief, title, goal, audience, requiredAll, demoClientId } = body.data;

  // DEMO-ONLY: when attributing on create, the target client must exist (cheap
  // pre-check before the expensive compose — mirrors the ingest route).
  let resolvedDemoClientId: string | undefined;
  if (demoClientId !== undefined) {
    const client = await prisma.appDemoClient.findUnique({
      where: { id: demoClientId },
      select: { id: true },
    });
    if (!client) {
      return errorResponse('Demo client not found', { code: 'DEMO_CLIENT_NOT_FOUND', status: 404 });
    }
    resolvedDemoClientId = client.id;
  }

  const agentResult = await loadComposerAgent(log);
  if (!agentResult.ok) return agentResult.response;

  const adminMeta: ComposeAdminMeta = {
    ...(goal !== undefined ? { goal } : {}),
    ...(audience !== undefined ? { audience } : {}),
  };
  const composed = await composeFromBrief(agentResult.value, { brief, adminMeta, adminId }, log);
  if (!composed.ok) return composed.response;

  const documentTitle = deriveComposeTitle(title, composed.value.inferredGoal);
  const result = await persistIngestion({
    documentTitle,
    ...(resolvedDemoClientId !== undefined ? { demoClientId: resolvedDemoClientId } : {}),
    extraction: composed.value,
    admin: adminMeta,
    // Omitted ⇒ all required (the UI checkbox is checked by default); explicit false ⇒ all optional.
    requiredness: requiredAll === false ? 'optional' : 'all',
    source: briefSource(brief),
  });

  logAdminAction({
    userId: adminId,
    action: 'questionnaire.compose',
    entityType: 'questionnaire',
    entityId: result.versionId,
    entityName: documentTitle,
    metadata: {
      questionnaireId: result.questionnaireId,
      versionId: result.versionId,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      demoClientId: resolvedDemoClientId ?? null,
    },
    clientIp: clientIP,
  });

  log.info('Questionnaire composed', {
    adminId,
    questionnaireId: result.questionnaireId,
    versionId: result.versionId,
    sectionCount: result.sectionCount,
    questionCount: result.questionCount,
  });

  return successResponse(
    {
      questionnaireId: result.questionnaireId,
      versionId: result.versionId,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      goal: result.goal,
      audience: result.audience,
      fieldProvenance: result.fieldProvenance,
    },
    undefined,
    { status: 201 }
  );
});

export const POST = handleCompose;
