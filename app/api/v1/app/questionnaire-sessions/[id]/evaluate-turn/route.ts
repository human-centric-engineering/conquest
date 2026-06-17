/**
 * Turn evaluation — run the interview-quality evaluator over ONE inspector turn.
 *
 * POST /api/v1/app/questionnaire-sessions/:id/evaluate-turn
 *   body: {
 *     turn: { turnIndex, calls: AgentCallTrace[] },   // the live inspector dump for the turn
 *     respondentMessage?, interviewerMessage?, recentMessages?   // conversation context (client-held)
 *   }
 *
 *   Admin-only, preview-session-only. Runs one structured reasoning-model call that judges the
 *   turn (instruction compliance, interviewing/extraction/selection quality, information gain,
 *   missed opportunities, prompt drift, cost/efficiency) and returns the verdict. A read-only
 *   *evaluation*: it persists nothing — inspector data is itself live-only, so the verdict is
 *   ephemeral (rendered in the drawer, copied/downloaded by the admin).
 *
 *   The dump is supplied by the client because inspector data is never persisted; it is validated
 *   here (external data → Zod, never `as`). The questionnaire objectives (goal, audience, strategy,
 *   tone) are loaded SERVER-SIDE from the session's version so they can't be spoofed.
 *
 *   Gated by the master flag AND the turn-evaluation sub-flag (the whole route is paid LLM work):
 *   404 when either is off. It additionally requires the session to be a *preview* — the same gate
 *   the inspector that produces the dump enforces — so it can only run where the inspector runs.
 *   Takes a per-admin LLM sub-cap. A failed evaluation returns a clean error envelope, never a 500
 *   that breaks the drawer.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { isRecord } from '@/lib/utils';

import { prisma } from '@/lib/db/client';
import { withTurnEvaluationEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  evaluateTurn,
  MAX_EVALUATED_CALLS,
  type TurnEvaluationContext,
  type TurnEvaluationInput,
} from '@/lib/app/questionnaire/turn-evaluation';
import { turnEvaluationLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';

/** One captured prompt message — mirrors `InspectorMessage`. */
const inspectorMessageSchema = z.object({
  role: z.string().max(50),
  content: z.string().max(100_000),
});

/** One agent/LLM call trace — mirrors `AgentCallTrace`. */
const agentCallTraceSchema = z.object({
  kind: z.enum(['llm', 'embedding']).optional(),
  label: z.string().min(1).max(200),
  model: z.string().max(200),
  provider: z.string().max(200),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  dimensions: z.number().int().nonnegative().optional(),
  prompt: z.array(inspectorMessageSchema).max(50),
  response: z.string().max(200_000),
});

const bodySchema = z.object({
  turn: z.object({
    turnIndex: z.number().int().nonnegative(),
    calls: z.array(agentCallTraceSchema).min(1).max(MAX_EVALUATED_CALLS),
  }),
  respondentMessage: z.string().max(50_000).optional(),
  interviewerMessage: z.string().max(50_000).optional(),
  recentMessages: z.array(z.string().max(50_000)).max(100).optional(),
});

/** The seeded evaluator agent's slug — its provider/model binding drives the call. */
const TURN_EVALUATOR_SLUG = 'turn-evaluator';

/** Pull the free-text persona out of the config's tone JSON, when present. */
function summariseTone(tone: unknown): string | undefined {
  if (isRecord(tone) && typeof tone.persona === 'string' && tone.persona.trim()) {
    return tone.persona.trim();
  }
  return undefined;
}

/** Compact, bounded summary of the version's audience JSON for the prompt. */
function summariseAudience(audience: unknown): string | undefined {
  if (audience === null || audience === undefined) return undefined;
  try {
    const s = typeof audience === 'string' ? audience : JSON.stringify(audience);
    if (!s || s === '{}' || s === 'null') return undefined;
    return s.slice(0, 2_000);
  } catch {
    return undefined;
  }
}

const handleEvaluateTurn = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const adminId = session.user.id;

  // Per-admin sub-cap on the paid call (the section 100/min is far too loose for a reasoning
  // completion). Checked before the DB work and the dispatch.
  const rl = turnEvaluationLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Turn-evaluation rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const body = await validateRequestBody(request, bodySchema);

  // Load the session + its version objectives/config. Preview-only: a real respondent session
  // never carries inspector data, so evaluating one would be meaningless (and a privacy leak).
  const sessionRow = await prisma.appQuestionnaireSession.findUnique({
    where: { id },
    select: {
      isPreview: true,
      version: {
        select: {
          goal: true,
          audience: true,
          config: { select: { selectionStrategy: true, tone: true } },
        },
      },
    },
  });
  if (!sessionRow || !sessionRow.isPreview) {
    // Looks like a missing route — the inspector (hence this route) only exists for previews.
    throw new NotFoundError('Preview session not found');
  }

  // The evaluator agent's binding (empty provider/model → system default at resolve time). A
  // missing agent means the seed never ran — a config problem, surfaced as a 404.
  const agent = await prisma.aiAgent.findFirst({
    where: { slug: TURN_EVALUATOR_SLUG, kind: 'judge' },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    log.error('No turn-evaluator agent found; run db:seed', { slug: TURN_EVALUATOR_SLUG });
    throw new NotFoundError('Turn evaluation is not configured');
  }

  const version = sessionRow.version;
  const context: TurnEvaluationContext = {
    ...(version.goal ? { goal: version.goal } : {}),
    ...(summariseAudience(version.audience)
      ? { audience: summariseAudience(version.audience) }
      : {}),
    ...(version.config?.selectionStrategy
      ? { selectionStrategy: version.config.selectionStrategy }
      : {}),
    ...(summariseTone(version.config?.tone) ? { tone: summariseTone(version.config?.tone) } : {}),
    ...(body.respondentMessage ? { respondentMessage: body.respondentMessage } : {}),
    ...(body.interviewerMessage ? { interviewerMessage: body.interviewerMessage } : {}),
    ...(body.recentMessages && body.recentMessages.length > 0
      ? { recentMessages: body.recentMessages }
      : {}),
  };

  const input: TurnEvaluationInput = { turn: body.turn, context };

  try {
    const { verdict, costUsd, model } = await evaluateTurn(
      input,
      {
        provider: agent.provider,
        model: agent.model,
        fallbackProviders: agent.fallbackProviders,
      },
      { agentId: agent.id, sessionId: id }
    );

    log.info('Turn evaluation complete', {
      sessionId: id,
      turnIndex: body.turn.turnIndex,
      calls: body.turn.calls.length,
      overallScore: verdict.overallScore,
      model,
      costUsd,
    });

    return successResponse({ verdict, costUsd, model });
  } catch (err) {
    log.error('Turn evaluation failed', {
      sessionId: id,
      turnIndex: body.turn.turnIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Turn evaluation failed', {
      code: 'evaluation_failed',
      status: 502,
    });
  }
});

export const POST = withTurnEvaluationEnabled(handleEvaluateTurn);
