/**
 * Generative-authoring compose endpoint (streaming, the watch-it-build surface).
 *
 * POST /api/v1/app/questionnaires/compose/stream
 *   Admin-only SSE. Runs the two-phase composer (outline → per-section questions)
 *   over a plain-English brief, forwarding progress events as the structure builds.
 *   On the terminal, it persists the assembled structure as a NEW draft
 *   questionnaire+version (the brief synthesized as source provenance) and emits a
 *   final `done` event carrying the new ids — so the client can open it in the
 *   Structure editor. Mirrors the data-slots `generate/stream` route's `drive()`
 *   pattern, except the questionnaire is created at the terminal (there is no
 *   pre-existing version, unlike data-slot generation).
 *
 * Auth: admin only. Rate limit: per-admin compose sub-cap (shared with the
 * non-streaming route).
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadComposerAgent } from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { persistIngestion, briefSource } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { composeRequestSchema } from '@/app/api/v1/app/questionnaires/_lib/compose-input';
import { streamComposeQuestionnaire } from '@/lib/app/questionnaire/ingestion/stream-compose';
import type { ComposeGenEvent } from '@/lib/app/questionnaire/ingestion/compose-events';
import type { AdminSuppliedMetadata } from '@/lib/app/questionnaire/ingestion/types';

function deriveComposeTitle(
  adminTitle: string | undefined,
  inferredGoal: string | undefined
): string {
  if (adminTitle && adminTitle.trim().length > 0) return adminTitle.trim();
  const goal = inferredGoal?.trim();
  if (goal) return goal.length > 80 ? `${goal.slice(0, 79)}…` : goal;
  return 'Untitled questionnaire';
}

const handleComposeStream = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIP = getClientIP(request);
  const adminId = session.user.id;

  const rl = composeLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Questionnaire compose stream rate limit exceeded', { adminId, reset: rl.reset });
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

  // DEMO-ONLY: when attributing on create, the target client must exist.
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
  const agent = agentResult.value;

  const adminSupplied: AdminSuppliedMetadata | undefined =
    goal !== undefined || audience !== undefined
      ? { ...(goal !== undefined ? { goal } : {}), ...(audience !== undefined ? { audience } : {}) }
      : undefined;

  // The async generator: forward the orchestrator's progress events, then persist
  // the assembled structure as a new draft and emit the terminal `done`. A persist
  // failure surfaces as an `error` event (the response is already streaming, so it
  // can't become a 5xx) — same contract as the data-slots stream route.
  async function* drive(): AsyncGenerator<ComposeGenEvent> {
    const gen = streamComposeQuestionnaire({
      brief,
      agent: {
        provider: agent.provider,
        model: agent.model,
        fallbackProviders: agent.fallbackProviders,
      },
      ...(adminSupplied !== undefined ? { adminSupplied } : {}),
      agentId: agent.id,
    });

    let fatal = false;
    let result = await gen.next();
    while (!result.done) {
      if (result.value.type === 'error') fatal = true;
      yield result.value;
      result = await gen.next();
    }
    if (fatal) return;

    const extraction = result.value;
    try {
      const documentTitle = deriveComposeTitle(title, extraction.inferredGoal);
      const persisted = await persistIngestion({
        documentTitle,
        ...(resolvedDemoClientId !== undefined ? { demoClientId: resolvedDemoClientId } : {}),
        extraction,
        admin: {
          ...(goal !== undefined ? { goal } : {}),
          ...(audience !== undefined ? { audience } : {}),
        },
        // Omitted ⇒ all required (the UI checkbox is checked by default); explicit false ⇒ all optional.
        requiredness: requiredAll === false ? 'optional' : 'all',
        source: briefSource(brief),
      });

      logAdminAction({
        userId: adminId,
        action: 'questionnaire.compose',
        entityType: 'questionnaire',
        entityId: persisted.versionId,
        entityName: documentTitle,
        metadata: {
          questionnaireId: persisted.questionnaireId,
          versionId: persisted.versionId,
          sectionCount: persisted.sectionCount,
          questionCount: persisted.questionCount,
          mode: 'stream',
          demoClientId: resolvedDemoClientId ?? null,
        },
        clientIp: clientIP,
      });

      log.info('Questionnaire composed (stream)', {
        adminId,
        questionnaireId: persisted.questionnaireId,
        versionId: persisted.versionId,
        sectionCount: persisted.sectionCount,
        questionCount: persisted.questionCount,
      });

      yield {
        type: 'done',
        questionnaireId: persisted.questionnaireId,
        versionId: persisted.versionId,
        sectionCount: persisted.sectionCount,
        questionCount: persisted.questionCount,
      };
    } catch (err) {
      log.error('Compose stream: persist failed (response already streamed)', {
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
      yield {
        type: 'error',
        code: 'persist_failed',
        message: 'The questionnaire was generated but could not be saved. Please try again.',
      };
    }
  }

  return sseResponse(drive(), { signal: request.signal });
});

export const POST = handleComposeStream;
