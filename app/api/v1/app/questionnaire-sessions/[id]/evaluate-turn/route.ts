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
 *   missed opportunities, prompt drift, cost/efficiency), persists the verdict alongside a
 *   snapshot of the input it judged (`AppQuestionnaireTurnEvaluation` — so it can later be
 *   surfaced, searched, commented on, and flagged for learning), and returns it with the new
 *   `evaluationId`. Persistence is best-effort: a write failure logs and returns a null id
 *   rather than losing the verdict the admin is waiting on.
 *
 *   The dump is supplied by the client because inspector data is never persisted elsewhere; it is
 *   validated here (external data → Zod, never `as`). The questionnaire objectives (goal, audience,
 *   strategy, tone) are loaded SERVER-SIDE from the session's version so they can't be spoofed.
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

import { prisma } from '@/lib/db/client';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';
import {
  evaluateTurn,
  type TurnEvaluationContext,
  type TurnEvaluationInput,
} from '@/lib/app/questionnaire/turn-evaluation';
import { turnEvaluationLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { persistTurnEvaluation } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';
import {
  buildObjectivesContext,
  loadTurnEvaluatorAgent,
  TURN_EVALUATOR_SLUG,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context';

const bodySchema = z.object({
  turn: inspectorTurnSchema,
  respondentMessage: z.string().max(50_000).optional(),
  interviewerMessage: z.string().max(50_000).optional(),
  recentMessages: z.array(z.string().max(50_000)).max(100).optional(),
});

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
          id: true,
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
  const agent = await loadTurnEvaluatorAgent();
  if (!agent) {
    log.error('No turn-evaluator agent found; run db:seed', { slug: TURN_EVALUATOR_SLUG });
    throw new NotFoundError('Turn evaluation is not configured');
  }

  const version = sessionRow.version;
  const context: TurnEvaluationContext = {
    ...buildObjectivesContext(version),
    ...(body.respondentMessage ? { respondentMessage: body.respondentMessage } : {}),
    ...(body.interviewerMessage ? { interviewerMessage: body.interviewerMessage } : {}),
    ...(body.recentMessages && body.recentMessages.length > 0
      ? { recentMessages: body.recentMessages }
      : {}),
  };

  const input: TurnEvaluationInput = { turn: body.turn, context };

  try {
    const { verdict, costUsd, model, provider } = await evaluateTurn(
      input,
      {
        provider: agent.provider,
        model: agent.model,
        fallbackProviders: agent.fallbackProviders,
      },
      { agentId: agent.id, sessionId: id }
    );

    // Persist the verdict + a snapshot of the input it judged. Failure here must not lose the
    // verdict the admin is waiting on — log it and return a null id so the drawer still renders
    // (the comment/flag affordances simply stay disabled until a successful persist).
    let evaluationId: string | null = null;
    try {
      const persisted = await persistTurnEvaluation({
        sessionId: id,
        questionnaireVersionId: sessionRow.version.id,
        verdict,
        evaluatedInput: input,
        evaluatorModel: model,
        evaluatorProvider: provider,
        evaluatorAgentId: agent.id,
        costUsd,
        evaluatedByUserId: adminId,
      });
      evaluationId = persisted.id;
    } catch (persistErr) {
      log.error('Turn evaluation persist failed', {
        sessionId: id,
        turnIndex: body.turn.turnIndex,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }

    log.info('Turn evaluation complete', {
      sessionId: id,
      turnIndex: body.turn.turnIndex,
      calls: body.turn.calls.length,
      overallScore: verdict.overallScore,
      model,
      costUsd,
      evaluationId,
    });

    return successResponse({ verdict, costUsd, model, evaluationId });
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

export const POST = handleEvaluateTurn;
