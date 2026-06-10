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
import { chatAttachmentsArraySchema } from '@/lib/validations/orchestration';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import {
  isAdaptiveSelectionEnabled,
  isAnswerExtractionEnabled,
  isAnswerRefinementEnabled,
  isCompletionEnabled,
  isAttachmentInputEnabled,
  isContradictionDetectionEnabled,
  isCostCapEnforcementEnabled,
  isDataSlotsEnabled,
  isQuestionPhrasingEnabled,
  withLiveSessionsEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { classifyCostCap } from '@/lib/app/questionnaire/session';
import { runTurn, runDataSlotTurn, type TurnState } from '@/lib/app/questionnaire/orchestrator';
import type { ChatEvent } from '@/types/orchestration';
import { turnLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { sumSessionTurnCost } from '@/app/api/v1/app/questionnaires/_lib/turns';
import {
  hasCostCapReachedEvent,
  pauseSession,
  recordCostCapReached,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { buildTurnInvokers } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers';
import { persistTurn } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import { streamOfferMessage } from '@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream';
import { streamQuestionMessage } from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';

const bodySchema = z.object({
  message: z.string().min(1).max(10_000),
  /** Optional files attached to this turn (images/documents) — read by the extractor. */
  attachments: chatAttachmentsArraySchema.optional(),
});

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

    // Cost cap (F6.3): grade the session's spend so far against its budget at the turn
    // boundary, before any per-turn work. Hard (≥100%) refuses this turn with 402 and
    // auto-pauses the session (the `paused` event + a `cost_cap_reached` marker); the status
    // gate above then rejects every later turn. Soft (≥90%) lets the turn run but flags
    // `costPressure` so the core offers completion early + the offer prose nudges a wrap-up,
    // and writes the soft marker once. Gated by its own sub-flag and a configured budget.
    const capUsd = loaded.base.config.costBudgetUsd;
    let costPressure: 'soft' | undefined;
    if (capUsd !== null && (await isCostCapEnforcementEnabled())) {
      const spentUsd = await sumSessionTurnCost(sessionId);
      const tier = classifyCostCap(spentUsd, capUsd);
      if (tier === 'hard') {
        // Pause FIRST — the pause is the enforcement (the status gate then 409s every later
        // turn); the audit event is secondary. Doing it first means a failed event write can't
        // leave the session active-but-recorded (which a retry would then double-record).
        await pauseSession(sessionId, { reason: 'cost_cap' });
        try {
          await recordCostCapReached(sessionId, { spentUsd, capUsd, tier: 'hard' });
        } catch (err) {
          log.error('Cost cap: hard event write failed (session already paused)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        log.info('Live turn refused: cost cap reached', { sessionId, spentUsd, capUsd });
        return errorResponse('Session cost budget exhausted', {
          code: 'COST_CAP_REACHED',
          status: 402,
          details: { spentUsd, capUsd },
        });
      }
      if (tier === 'soft') {
        costPressure = 'soft';
        // Best-effort: the soft cap is an advisory nudge, so a bookkeeping failure must not
        // fail a turn that should run. (The hard cap above fails closed; soft fails open.)
        try {
          if (!(await hasCostCapReachedEvent(sessionId, 'soft'))) {
            await recordCostCapReached(sessionId, { spentUsd, capUsd, tier: 'soft' });
          }
        } catch (err) {
          log.error('Cost cap: soft event write failed (continuing turn)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Resolve the per-step flags (async DB reads) up front, so the pure core stays sync.
    const [
      extraction,
      contradiction,
      refinement,
      completion,
      adaptive,
      attachmentInput,
      questionPhrasing,
      dataSlotsFlag,
    ] = await Promise.all([
      isAnswerExtractionEnabled(),
      isContradictionDetectionEnabled(),
      isAnswerRefinementEnabled(),
      isCompletionEnabled(),
      isAdaptiveSelectionEnabled(),
      isAttachmentInputEnabled(),
      isQuestionPhrasingEnabled(),
      isDataSlotsEnabled(),
    ]);

    // Data Slots feature: run in data-slot mode when the flag is on AND the version actually has
    // data slots (the conversation targets data slots; questions fill in the background).
    const dataSlots = loaded.base.dataSlots ?? [];
    const dataSlotMode = dataSlotsFlag && dataSlots.length > 0;

    // Attachments only flow when the sub-flag is on (dark-launch): with it off, a client
    // that sends attachments anyway gets a text-only turn — the paid multimodal path stays shut.
    const attachments =
      attachmentInput && body.attachments && body.attachments.length > 0
        ? body.attachments
        : undefined;

    const state: TurnState = {
      ...loaded.base,
      userMessage: body.message,
      flags: { extraction, contradiction, refinement, completion },
      ...(attachments ? { attachments } : {}),
      ...(costPressure ? { costPressure } : {}),
    };

    const invokers = await buildTurnInvokers({
      userId,
      slots: loaded.slots,
      activeQuestionKey: loaded.activeQuestionKey,
      adaptiveEnabled: adaptive,
      // Data Slots feature: feed the data slots so the SAME extraction call fills them too.
      ...(dataSlotMode
        ? {
            dataSlotCandidates: dataSlots.map((s) => ({
              key: s.key,
              name: s.name,
              description: s.description,
              theme: s.theme,
            })),
          }
        : {}),
    });

    const keyToSlotId = new Map(loaded.slots.map((s) => [s.key, s.id]));
    // Hoist the conversational-phraser inputs out of `loaded` (narrowed non-null here) so the
    // async generator below — where TS loses the narrowing — closes over plain values.
    const slotById = new Map(loaded.slots.map((s) => [s.id, s]));
    const dataSlotKeyToId = new Map(dataSlots.map((s) => [s.key, s.id]));
    const { byId, activeQuestionKey, meta } = loaded;

    log.info('Live turn started', { sessionId, versionId: loaded.session.versionId, userId });

    async function* drive(): AsyncGenerator<ChatEvent> {
      yield { type: 'start', conversationId: sessionId, messageId: sessionId };

      // Data Slots feature: data-slot mode runs the parallel orchestrator (targets data slots,
      // fills questions in the background); otherwise the question-mode pipeline.
      const result = dataSlotMode
        ? await runDataSlotTurn(state, invokers)
        : await runTurn(state, invokers);

      // Side-band frames the core determined (contradiction warnings, fail-soft notices).
      for (const ev of result.events) yield ev;

      // Render the reply: an offer turn streams its prose token-by-token off the provider (the
      // offer composer); a question turn streams a conversational rendering of the prompt when
      // phrasing is on (fail-soft to verbatim inside the helper), else carries deterministic text
      // emitted as chunked content; terminal turns are always deterministic. Track any extra
      // (offer/phrasing) spend to fold into the turn's cost.
      let agentResponse: string;
      let extraCostUsd = 0;
      // The generic `targetedQuestionId` column holds a QUESTION id (question/sweep turns) or a
      // DATA-SLOT id (data-slot turns) — the loader resolves whichever matches next turn.
      let persistedTargetedId: string | null = result.targetedQuestionId;
      if (result.response.kind === 'offer') {
        const offer = yield* streamOfferMessage({
          input: result.response.input,
          userId,
          sessionId,
        });
        agentResponse = offer.message;
        extraCostUsd = offer.costUsd;
      } else if (result.response.kind === 'data_slot') {
        // Data Slots feature: phrase the targeted data slot as a natural interview question
        // (acknowledge prior answer · deepen vs bridge to a new area · re-ask when uncaptured).
        const r = result.response;
        const phrased = yield* streamQuestionMessage({
          input: {
            prompt: `${r.name} — ${r.description}`,
            type: 'free_text',
            ...(meta.goal ? { goal: meta.goal } : {}),
            ...(meta.audience ? { audience: meta.audience } : {}),
            recentMessages: state.recentMessages,
            lastUserMessage: body.message,
            isReask: r.isReask,
            isOpening: state.selectionRound === 0,
            isTransition: r.isTransition,
          },
          userId,
          sessionId,
        });
        agentResponse = phrased.message;
        extraCostUsd = phrased.costUsd;
        persistedTargetedId = r.dataSlotId;
      } else if (result.response.kind === 'question' && (questionPhrasing || dataSlotMode)) {
        // Conversational interviewer pass: acknowledge the prior answer + ask the targeted
        // question naturally. Re-ask = this turn re-selected the question the previous turn
        // asked (its answer wasn't captured); opening = the first turn of the session.
        const targetedKey = result.targetedQuestionId
          ? (byId.get(result.targetedQuestionId)?.key ?? null)
          : null;
        const slot = result.targetedQuestionId
          ? slotById.get(result.targetedQuestionId)
          : undefined;
        const phrased = yield* streamQuestionMessage({
          input: {
            prompt: result.response.text,
            type: slot?.type ?? 'free_text',
            ...(slot?.typeConfig !== undefined ? { typeConfig: slot.typeConfig } : {}),
            ...(slot?.guidelines ? { guidelines: slot.guidelines } : {}),
            ...(meta.goal ? { goal: meta.goal } : {}),
            ...(meta.audience ? { audience: meta.audience } : {}),
            recentMessages: state.recentMessages,
            lastUserMessage: body.message,
            isReask: targetedKey !== null && targetedKey === activeQuestionKey,
            isOpening: state.selectionRound === 0,
          },
          userId,
          sessionId,
        });
        agentResponse = phrased.message;
        extraCostUsd = phrased.costUsd;
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
          targetedQuestionId: persistedTargetedId,
          toolCalls: result.toolCalls,
          costUsd,
          upserts: result.sideEffects.answerUpserts,
          refinements: result.sideEffects.answerRefinements,
          keyToSlotId,
          // Data Slots feature: persist the respondent-facing fills captured this turn.
          ...(dataSlotMode
            ? {
                dataSlotFills: result.sideEffects.dataSlotFills ?? [],
                dataSlotKeyToId,
              }
            : {}),
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
