/**
 * Turn persistence for the live turn route (F6.1, PR4).
 *
 * {@link persistTurn} writes the turn's answer side-effects through the F4.4 slot seam,
 * then records the turn (stamping `lastUpdatedTurnId` on the answers it touched). The
 * offer prose is streamed separately (`offer-stream.ts`).
 */

import { Prisma } from '@prisma/client';

import type {
  AnswerSlotIntent,
  DataSlotFillIntent,
} from '@/lib/app/questionnaire/extraction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { PendingContradiction } from '@/lib/app/questionnaire/contradiction/types';
import { prisma } from '@/lib/db/client';
import { applyRefinement } from '@/lib/app/questionnaire/refinement';
import type { ToolCallRecord } from '@/lib/app/questionnaire/orchestrator';
import type { SessionWarning } from '@/lib/app/questionnaire/chat/types';
import type { ReasoningStep } from '@/lib/app/questionnaire/reasoning';
import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector';
import {
  loadAnswerSlot,
  loadRespondentEditedSlotIds,
  persistRefinement,
  upsertAnswerSlot,
} from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import {
  upsertDataSlotFill,
  reconcileChatDataSlotFills,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';
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
  /** Data Slots feature: the `AppDataSlot.id` this turn targeted (data-slot mode) — drives the
   *  per-slot re-ask/park counter. Null for question/sweep/offer turns. */
  targetedDataSlotId?: string | null;
  toolCalls: ToolCallRecord[];
  /** Side-band notices this turn surfaced — persisted on the turn for inline replay on resume. */
  warnings?: SessionWarning[];
  /** Live "watch it think" reasoning trace — persisted (when the version opted in) for replay on resume. */
  reasoning?: ReasoningStep[];
  /** The saved Turn Inspector dump — every LLM/embedding call this turn made. Persisted for every
   *  session so it can be re-evaluated later by `publicRef`. Empty/omitted for a turn with none. */
  inspectorCalls?: AgentCallTrace[];
  costUsd: number;
  upserts: AnswerSlotIntent[];
  refinements: RefinementDecision[];
  keyToSlotId: Map<string, string>;
  /** Data Slots feature: the data-slot fills to upsert + their key→id map (data-slot mode). */
  dataSlotFills?: DataSlotFillIntent[];
  dataSlotKeyToId?: Map<string, string>;
  /**
   * Probe-confirm contradiction flow: how to update `AppQuestionnaireSession.pendingContradiction`.
   * An object parks a raised probe; `null` clears a resolved one; `undefined` (the default) leaves it
   * untouched. Written before the turn is recorded so a mid-turn crash can't strand a stale probe.
   */
  pendingContradiction?: PendingContradiction | null;
  /** The send attempt's idempotency key (F7.x retry) — stamped on the turn for dedup-and-replay. */
  idempotencyKey?: string | null;
}): Promise<string> {
  const sideEffectAnswerIds: string[] = [];
  const sideEffectDataSlotIds: string[] = [];
  // Question slots this turn actually answered (extraction or refinement) — drives the chat-mode
  // data-slot reconciliation below. Respondent-edited slots we skip writing are NOT included
  // (their fills are already kept in sync by the form-mode `reconcileDataSlotFills`).
  const answeredQuestionSlotIds: string[] = [];

  // P-presentation: answers the respondent set themselves in form view are authoritative.
  // The per-turn pipeline must not silently overwrite them — skip any extraction/refinement
  // write that targets a respondent-edited slot (contradiction detection still warns; that's
  // a read on its own channel, not a write here).
  const respondentEdited = await loadRespondentEditedSlotIds(opts.sessionId);

  for (const intent of opts.upserts) {
    const slotId = opts.keyToSlotId.get(intent.slotKey);
    if (!slotId) continue;
    if (respondentEdited.has(slotId)) continue; // respondent's own answer wins
    const id = await upsertAnswerSlot(opts.sessionId, slotId, {
      value: intent.value,
      provenance: intent.provenance,
      rationale: intent.rationale,
      confidence: intent.confidence,
    });
    sideEffectAnswerIds.push(id);
    answeredQuestionSlotIds.push(slotId);
  }

  for (const decision of opts.refinements) {
    const slotId = opts.keyToSlotId.get(decision.slotKey);
    if (!slotId) continue;
    if (respondentEdited.has(slotId)) continue; // respondent's own answer wins
    // Mirror the F4.4 refine-answer route: load the existing answer, merge it via the
    // pure `applyRefinement`, and write the new value + provenance + the *appended*
    // refinementHistory back. The live loop previously persisted only the corrected
    // value (history append was an F6.1 follow-up), so real sessions silently dropped
    // the "evolved across turns" audit trail the preview route keeps.
    const loaded = await loadAnswerSlot(opts.sessionId, slotId);
    if (loaded) {
      const refined = applyRefinement(loaded.existing, decision);
      await persistRefinement(loaded.id, refined);
      if (!sideEffectAnswerIds.includes(loaded.id)) sideEffectAnswerIds.push(loaded.id);
    } else {
      // Defensive: a refinement targeting a slot with no captured answer (shouldn't
      // happen — refinement acts on prior answers). Fall back to a plain upsert so the
      // value isn't lost, rather than skip it or throw.
      const id = await upsertAnswerSlot(opts.sessionId, slotId, {
        value: decision.newValue,
        provenance: 'refined',
        rationale: decision.rationale,
        confidence: decision.confidence,
      });
      if (!sideEffectAnswerIds.includes(id)) sideEffectAnswerIds.push(id);
    }
    answeredQuestionSlotIds.push(slotId);
  }

  // Data Slots feature: upsert the data-slot fills (the respondent-facing capture).
  if (opts.dataSlotFills && opts.dataSlotKeyToId) {
    for (const fill of opts.dataSlotFills) {
      const dataSlotId = opts.dataSlotKeyToId.get(fill.dataSlotKey);
      if (!dataSlotId) continue;
      const id = await upsertDataSlotFill(opts.sessionId, dataSlotId, {
        value: fill.value,
        paraphrase: fill.paraphrase,
        confidence: fill.confidence,
        provenance: fill.provenance,
        ...(fill.rationale !== undefined ? { rationale: fill.rationale } : {}),
        ...(fill.provisional !== undefined ? { provisional: fill.provisional } : {}),
      });
      sideEffectDataSlotIds.push(id);
    }
  }

  // Chat-mode data-slot reconciliation: the extractor can answer a mapped question while leaving its
  // PARENT data slot empty (a generation miss the prompt asks it to avoid but can't guarantee). Fill
  // that gap deterministically from the answers just written — the same safety net the form surface
  // already has (`reconcileDataSlotFills`). Gap-filling only: it skips any slot that already has a fill
  // (incl. the extractor's just-written ones above), so it never overwrites a richer paraphrase. A
  // no-op when the version has no data slots or nothing was answered.
  const reconciledDataSlotIds = await reconcileChatDataSlotFills({
    sessionId: opts.sessionId,
    answeredQuestionSlotIds,
  });
  sideEffectDataSlotIds.push(...reconciledDataSlotIds);

  // Probe-confirm flow: park a raised probe or clear a resolved one on the session. `undefined` =
  // leave untouched (the common case); `null` writes SQL NULL (DbNull) to clear.
  if (opts.pendingContradiction !== undefined) {
    await prisma.appQuestionnaireSession.update({
      where: { id: opts.sessionId },
      data: {
        pendingContradiction:
          opts.pendingContradiction === null
            ? Prisma.DbNull
            : (opts.pendingContradiction as unknown as Prisma.InputJsonValue),
      },
    });
  }

  return recordTurn({
    sessionId: opts.sessionId,
    userMessage: opts.userMessage,
    agentResponse: opts.agentResponse,
    targetedQuestionId: opts.targetedQuestionId,
    ...(opts.warnings && opts.warnings.length > 0 ? { warnings: opts.warnings } : {}),
    ...(opts.reasoning && opts.reasoning.length > 0 ? { reasoning: opts.reasoning } : {}),
    ...(opts.inspectorCalls && opts.inspectorCalls.length > 0
      ? { inspectorCalls: opts.inspectorCalls }
      : {}),
    ...(opts.targetedDataSlotId !== undefined
      ? { targetedDataSlotId: opts.targetedDataSlotId }
      : {}),
    toolCalls: opts.toolCalls,
    sideEffectAnswerIds,
    sideEffectDataSlotIds,
    costUsd: opts.costUsd > 0 ? opts.costUsd : null,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
}
