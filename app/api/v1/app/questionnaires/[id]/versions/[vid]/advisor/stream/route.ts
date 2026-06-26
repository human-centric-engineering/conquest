/**
 * Config Advisor endpoint (streaming).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/advisor/stream
 *   Admin-only SSE. Assembles the whole-questionnaire snapshot (structure, goal/audience, run-time
 *   config, data slots, scoring, lifecycle/session state) and drives the two-phase advisor:
 *   a streamed narrative review followed by structured conflicts + one-click config suggestions.
 *   Nothing is persisted — the advisor is ephemeral and re-runnable. ADMIN-TRIGGERED ONLY: there is
 *   no GET and no auto-run; the client POSTs this when the admin presses "Run advisor".
 *
 * Auth: admin only. Flag: 404 when the master OR advisor sub-flag is off. Rate limit: per-admin
 * advisor sub-cap (two reasoning calls per run). Mirrors the compose `stream` route's `drive()`.
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

import { withAdvisorEnabled } from '@/lib/app/questionnaire/feature-flag';
import { QUESTIONNAIRE_ADVISOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { advisorLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadAdvisorContext } from '@/app/api/v1/app/questionnaires/_lib/advisor-context';
import { streamAdvisor } from '@/lib/app/questionnaire/advisor/stream-advisor';
import type { AdvisorGenEvent } from '@/lib/app/questionnaire/advisor/advisor-events';

const handleAdvisorStream = withAdminAuth<{ id: string; vid: string }>(
  async (request: NextRequest, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    const rl = advisorLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Questionnaire advisor rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    // The seeded advisor agent (provider-agnostic binding + cost attribution) and the snapshot are
    // independent, so resolve them concurrently before the stream can start.
    const [agent, ctx] = await Promise.all([
      prisma.aiAgent.findUnique({
        where: { slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG },
        select: { id: true, provider: true, model: true, fallbackProviders: true },
      }),
      loadAdvisorContext(id, vid),
    ]);

    if (!agent) {
      log.error('Config Advisor agent not seeded; run db:seed', {
        slug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
      });
      return errorResponse('The Config Advisor is not configured', {
        code: 'ADVISOR_NOT_CONFIGURED',
        status: 503,
      });
    }
    // Hoist the narrowed agent so the `drive()` closure below keeps the non-null type.
    const advisorAgent = agent;

    // 404 if the version isn't under this questionnaire.
    if (!ctx.ok) return ctx.response;
    // Hoist the narrowed value so the closure sees `AdvisorContext`, not the union.
    const context = ctx.value;

    logAdminAction({
      userId: adminId,
      action: 'questionnaire.advisor',
      entityType: 'questionnaire',
      entityId: vid,
      entityName: context.questionnaire.title,
      metadata: { questionnaireId: id, versionId: vid },
      clientIp,
    });

    // The async generator: forward the orchestrator's progress events, then emit the terminal
    // `done`. A mid-stream failure surfaces as an `error` event (the response is already streaming,
    // so it can't become a 5xx) — same contract as the compose stream route.
    async function* drive(): AsyncGenerator<AdvisorGenEvent> {
      const gen = streamAdvisor({
        context,
        agent: {
          provider: advisorAgent.provider,
          model: advisorAgent.model,
          fallbackProviders: advisorAgent.fallbackProviders,
        },
        agentId: advisorAgent.id,
      });

      let fatal = false;
      for await (const ev of gen) {
        if (ev.type === 'error') fatal = true;
        yield ev;
      }
      if (fatal) return;

      log.info('Questionnaire advisor run complete', {
        adminId,
        questionnaireId: id,
        versionId: vid,
      });
      yield { type: 'done' };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = withAdvisorEnabled(handleAdvisorStream);
