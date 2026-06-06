/**
 * Turn rendering + persistence helpers for the live turn route (F6.1, PR4).
 *
 * Two side-effecting steps the route runs around the pure orchestrator:
 *  - {@link renderOfferMessage} — compose the completion-offer prose for an offer turn via
 *    the F4.5 capability (fail-soft to a deterministic fallback). PR5 swaps this for a
 *    token stream; PR4 emits it as chunked content.
 *  - {@link persistTurn} — write the turn's answer side-effects through the F4.4 slot seam,
 *    then record the turn (stamping `lastUpdatedTurnId` on the answers it touched).
 */

import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { prisma } from '@/lib/db/client';
import type { ComposeCompletionOfferData } from '@/lib/app/questionnaire/capabilities';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { OfferComposeInput, ToolCallRecord } from '@/lib/app/questionnaire/orchestrator';
import { upsertAnswerSlot } from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import { recordTurn } from '@/app/api/v1/app/questionnaires/_lib/turns';

/** Deterministic fallback offer when the LLM phrasing is disabled or fails (fail-soft). */
export const FALLBACK_OFFER_MESSAGE =
  "Thanks — I think we've covered enough. Would you like to submit your responses now?";

/**
 * Compose the completion-offer prose for an offer turn. Fail-soft: a missing agent or a
 * capability failure returns {@link FALLBACK_OFFER_MESSAGE}, never throws — the turn must
 * still produce an offer the respondent can act on.
 */
export async function renderOfferMessage(opts: {
  input: OfferComposeInput;
  userId: string;
  sessionId: string;
}): Promise<string> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) return FALLBACK_OFFER_MESSAGE;

  const dispatch = await capabilityDispatcher.dispatch(
    COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
    {
      coverage: opts.input.coverage,
      answeredCount: opts.input.answeredCount,
      capReached: opts.input.capReached,
      coveredSlots: opts.input.coveredSlots,
      remainingSlots: opts.input.remainingSlots,
      ...(opts.input.recentMessages.length > 0
        ? { recentMessages: opts.input.recentMessages }
        : {}),
      sessionId: opts.sessionId,
    },
    {
      userId: opts.userId,
      agentId: agent.id,
      entityContext: {
        completionAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success || !dispatch.data) return FALLBACK_OFFER_MESSAGE;
  return (dispatch.data as ComposeCompletionOfferData).offer.offerMessage;
}

/**
 * Persist a turn's answer side-effects and record the turn. Extraction intents and
 * refinement decisions are written through the F4.4 slot seam (`upsertAnswerSlot`); the
 * resulting answer ids are stamped with the new turn id via {@link recordTurn}. A slotKey
 * that doesn't resolve to a slot in this version is skipped (a stale key shouldn't 500).
 */
export async function persistTurn(opts: {
  sessionId: string;
  userMessage: string;
  agentResponse: string;
  targetedQuestionId: string | null;
  toolCalls: ToolCallRecord[];
  costUsd: number;
  upserts: AnswerSlotIntent[];
  refinements: RefinementDecision[];
  keyToSlotId: Map<string, string>;
}): Promise<string> {
  const sideEffectAnswerIds: string[] = [];

  for (const intent of opts.upserts) {
    const slotId = opts.keyToSlotId.get(intent.slotKey);
    if (!slotId) continue;
    const id = await upsertAnswerSlot(opts.sessionId, slotId, {
      value: intent.value,
      provenance: intent.provenance,
      rationale: intent.rationale,
      confidence: intent.confidence,
    });
    sideEffectAnswerIds.push(id);
  }

  for (const decision of opts.refinements) {
    const slotId = opts.keyToSlotId.get(decision.slotKey);
    if (!slotId) continue;
    // PR4 persists the corrected value with `refined` provenance via the upsert seam; the
    // full refinementHistory append (persistRefinement) is a follow-up.
    const id = await upsertAnswerSlot(opts.sessionId, slotId, {
      value: decision.newValue,
      provenance: 'refined',
      rationale: decision.rationale,
      confidence: decision.confidence,
    });
    if (!sideEffectAnswerIds.includes(id)) sideEffectAnswerIds.push(id);
  }

  return recordTurn({
    sessionId: opts.sessionId,
    userMessage: opts.userMessage,
    agentResponse: opts.agentResponse,
    targetedQuestionId: opts.targetedQuestionId,
    toolCalls: opts.toolCalls,
    sideEffectAnswerIds,
    costUsd: opts.costUsd > 0 ? opts.costUsd : null,
  });
}
