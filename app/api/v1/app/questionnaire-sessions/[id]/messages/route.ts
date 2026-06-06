/**
 * Live respondent turn — streaming (SSE) (F6.1, PR4).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/messages
 *   body: { message: string }
 *
 * The streaming turn loop. Mirrors the consumer chat route's outer shape but drives the
 * deterministic per-turn orchestrator (NOT `streamChat`): build the turn state from the
 * session, run the pipeline (extract → detect → refine → assess → respond) with the real
 * capability invokers, stream the reply, and persist the answers + turn record. The
 * completion-offer prose is composed via the F4.5 capability and emitted as chunked
 * `content` here; PR5 upgrades it to true token streaming.
 *
 * Gate order: live-sessions flag (404 before auth) → load session → access (authenticated
 * owner OR a valid anonymous session token) → status must be `active` → per-turn sub-cap →
 * body validation. Per-step sub-flag gating: a disabled sub-feature is skipped gracefully
 * (the turn still runs). Capability failures are fail-soft (a `warning` frame, never a 5xx
 * once streaming).
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { sseResponse } from '@/lib/api/sse';
import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import {
  isAdaptiveSelectionEnabled,
  isAnswerExtractionEnabled,
  isAnswerRefinementEnabled,
  isCompletionEnabled,
  isContradictionDetectionEnabled,
  withLiveSessionsEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { runTurn, type TurnState } from '@/lib/app/questionnaire/orchestrator';
import type { ChatEvent } from '@/types/orchestration';
import { turnLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { buildTurnInvokers } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers';
import { persistTurn } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import { streamOfferMessage } from '@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';

const bodySchema = z.object({ message: z.string().min(1).max(10_000) });

/** Chunk text into small pieces for a streamed feel (true token streaming is PR5). */
function chunkText(text: string, size = 48): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function handleMessage(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const loaded = await buildTurnContext(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    // Access: an authenticated owner OR a valid anonymous session token (no-login surface).
    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }
    const userId = access.userId;

    if (loaded.session.status !== 'active') {
      return errorResponse(`Session is ${loaded.session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    const limit = turnLimiter.check(access.rateKey);
    if (!limit.success) return createRateLimitResponse(limit);

    const body = await validateRequestBody(request, bodySchema);

    // Resolve the per-step flags (async DB reads) up front, so the pure core stays sync.
    const [extraction, contradiction, refinement, completion, adaptive] = await Promise.all([
      isAnswerExtractionEnabled(),
      isContradictionDetectionEnabled(),
      isAnswerRefinementEnabled(),
      isCompletionEnabled(),
      isAdaptiveSelectionEnabled(),
    ]);

    const state: TurnState = {
      ...loaded.base,
      userMessage: body.message,
      flags: { extraction, contradiction, refinement, completion },
    };

    const invokers = await buildTurnInvokers({
      userId,
      slots: loaded.slots,
      activeQuestionKey: loaded.activeQuestionKey,
      adaptiveEnabled: adaptive,
    });

    const keyToSlotId = new Map(loaded.slots.map((s) => [s.key, s.id]));

    log.info('Live turn started', { sessionId, versionId: loaded.session.versionId, userId });

    async function* drive(): AsyncGenerator<ChatEvent> {
      yield { type: 'start', conversationId: sessionId, messageId: sessionId };

      const result = await runTurn(state, invokers);

      // Side-band frames the core determined (contradiction warnings, fail-soft notices).
      for (const ev of result.events) yield ev;

      // Render the reply: an offer turn streams its prose token-by-token off the provider
      // (the offer composer); a question/terminal turn carries deterministic text emitted as
      // chunked content. Track any extra (offer) spend to fold into the turn's cost.
      let agentResponse: string;
      let extraCostUsd = 0;
      if (result.response.kind === 'offer') {
        const offer = yield* streamOfferMessage({
          input: result.response.input,
          userId,
          sessionId,
        });
        agentResponse = offer.message;
        extraCostUsd = offer.costUsd;
      } else {
        agentResponse = result.response.text;
        for (const delta of chunkText(agentResponse)) yield { type: 'content', delta };
      }
      const costUsd = result.costUsd + extraCostUsd;

      // Persist after the reply is composed — a write failure is logged, not retro-failed
      // onto an already-streamed response (the cost rows are logged by the capabilities).
      try {
        await persistTurn({
          sessionId,
          userMessage: body.message,
          agentResponse,
          targetedQuestionId: result.targetedQuestionId,
          toolCalls: result.toolCalls,
          costUsd,
          upserts: result.sideEffects.answerUpserts,
          refinements: result.sideEffects.answerRefinements,
          keyToSlotId,
        });
      } catch (err) {
        log.error('Turn persistence failed (response already streamed)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      yield {
        type: 'done',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd,
      };
    }

    return sseResponse(drive(), { signal: request.signal });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = withLiveSessionsEnabled(handleMessage);
