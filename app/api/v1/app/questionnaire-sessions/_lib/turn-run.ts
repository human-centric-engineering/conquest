/**
 * Turn persistence for the live turn route (F6.1, PR4).
 *
 * {@link persistTurn} writes the turn's answer side-effects through the F4.4 slot seam,
 * then records the turn (stamping `lastUpdatedTurnId` on the answers it touched). The
 * offer prose is streamed separately (`offer-stream.ts`).
 */

import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { ToolCallRecord } from '@/lib/app/questionnaire/orchestrator';
import { upsertAnswerSlot } from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import { recordTurn } from '@/app/api/v1/app/questionnaires/_lib/turns';

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
