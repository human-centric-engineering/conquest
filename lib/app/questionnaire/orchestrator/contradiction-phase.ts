/**
 * The shared contradiction phase for both per-turn orchestrators (`runTurn` and `runDataSlotTurn`).
 *
 * Owns the F4.3/F4.4 logic so question mode and data-slot mode behave identically:
 *
 *   - **Resolution** — when a {@link PendingContradiction} is awaiting confirmation (a `probe` was
 *     raised on a PRIOR turn), THIS turn's message is the answer to it: run the refiner against the
 *     parked finding (apply the change on confirm, keep otherwise) and clear the pending state. No
 *     fresh detection runs while resolving.
 *   - **Detect** — otherwise, run the detector (gated by mode/cadence/answer floor). This covers a
 *     turn the respondent TYPED and a turn they answered by tapping a question's answer control:
 *     checking is about the answers, not the keyboard. The opening turn has neither and is skipped.
 *     On a hit it
 *     **defers**: raise a reconciliation question (`contradiction_probe` response), suppress this
 *     turn's writes (nothing is overwritten before the respondent confirms), and park the finding as
 *     a `PendingContradiction`. The blue notice shows the EXPLANATION only.
 *
 * Checking being on therefore always means ASKING. The retired `flag` mode surfaced the conflict and
 * let the refiner rewrite the answer immediately, without the respondent's say-so; the read path now
 * resolves it to `probe` (see `resolveContradictionMode`) and that arm is gone.
 *
 * Pure relative to its injected invokers; the orchestrator folds the result into its turn output.
 */

import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  applyCompareWindow,
  buildContradictionNoticeMessage,
  buildContradictionProbe,
  contradictionKey,
  isSurfaceableContradiction,
  shouldRunDetection,
  type ContradictionProbeLabels,
} from '@/lib/app/questionnaire/contradiction';
import type {
  ContradictionFinding,
  ContradictionResolution,
  PendingContradiction,
  RaisedContradiction,
} from '@/lib/app/questionnaire/contradiction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { ChatEvent } from '@/types/orchestration';
import type {
  CapabilityInvokers,
  ExistingAnswerView,
  ToolCallRecord,
  TurnState,
} from '@/lib/app/questionnaire/orchestrator/types';

/** Fewest answers a contradiction pass needs — the detector capability enforces `min(2)`. */
export const MIN_CONTRADICTION_ANSWERS = 2;

/** Append a tool-call record (exactOptional-safe). */
function toolCall(
  slug: string,
  success: boolean,
  opts: { code?: string; latencyMs?: number } = {}
): ToolCallRecord {
  return {
    slug,
    success,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
  };
}

/** What the contradiction phase produced for the orchestrator to fold in. */
export interface ContradictionPhaseResult {
  /** Findings surfaced this turn (empty on a resolution turn — no fresh detection runs). */
  contradictions: ContradictionFinding[];
  /** Refinement decisions to persist — from `flag`-mode immediate refine OR a confirmed resolution. */
  answerRefinements: RefinementDecision[];
  toolCalls: ToolCallRecord[];
  /** Side-band notices (the blue "I noticed something" box — explanation text). */
  events: ChatEvent[];
  costUsd: number;
  /**
   * A reconciliation question to ASK this turn instead of selecting the next question (probe mode,
   * fresh contradiction). The orchestrator sets a `contradiction_probe` response and skips selection.
   */
  probe?: { text: string; slotKeys: string[] };
  /**
   * When `true`, the orchestrator must DROP this turn's answer writes (upserts + data-slot fills):
   * a probe was raised, so nothing is recorded until the respondent confirms next turn.
   */
  suppressWrites: boolean;
  /**
   * Pending-state side effect: an object = park this finding; `null` = a pending one was resolved
   * (clear it); `undefined` = leave the session's pending state untouched.
   */
  pendingContradiction?: PendingContradiction | null;
  /**
   * The updated "don't nag" ledger to persist, when this turn raised a fresh contradiction or resolved
   * a pending one. `undefined` = the ledger is unchanged this turn. Always the FULL list.
   */
  raisedContradictions?: RaisedContradiction[];
}

/** Build a ledger entry for a freshly-raised contradiction (identity = its canonical slot-key set). */
export function raisedEntry(
  finding: ContradictionFinding,
  resolution: ContradictionResolution,
  raisedAtTurnIndex: number
): RaisedContradiction {
  return {
    key: contradictionKey(finding.slotKeys),
    slotKeys: finding.slotKeys,
    resolution,
    raisedAtTurnIndex,
  };
}

/** The distinct conflicts a pending probe parked — its `findings`, or the single legacy conflict. */
function pendingConflicts(pending: PendingContradiction): Array<{ slotKeys: string[] }> {
  return pending.findings && pending.findings.length > 0
    ? pending.findings
    : [{ slotKeys: pending.slotKeys }];
}

/**
 * Stamp the resolution outcome onto EVERY ledger entry the pending probe covered (a combined probe can
 * park several), returning the full updated ledger. Per-conflict outcome:
 *   - `unresolved` — refinement never ran, OR this conflict's slots were NOT refined AND it was one of
 *     SEVERAL bundled in a combined probe (a single reply can't have addressed every point, so an
 *     un-refined one stays open — the completion sweep must still catch it, not silently drop it);
 *   - `resolved` — at least one of that conflict's slots was actually refined this turn;
 *   - `kept` — a SOLE conflict the respondent replied to without a change (they declined it).
 * Defensive: a covered conflict with no matching ledger entry (parked before the column existed) is
 * appended, so it is still suppressed from here on.
 */
function resolvePendingInLedger(
  ledger: RaisedContradiction[],
  pending: PendingContradiction,
  refinedSlotKeys: ReadonlySet<string>
): RaisedContradiction[] {
  const conflicts = pendingConflicts(pending);
  const bundled = conflicts.length > 1;
  const outcome = new Map<string, ContradictionResolution>();
  for (const conflict of conflicts) {
    const refined = conflict.slotKeys.some((k) => refinedSlotKeys.has(k));
    const resolution: ContradictionResolution = refined
      ? 'resolved'
      : // Un-refined: `kept` only when it was the SOLE conflict (a deliberate decline). In a bundle
        // we can't tell "declined" from "didn't get to it", so leave it open for the final sweep.
        bundled
        ? 'unresolved'
        : 'kept';
    outcome.set(contradictionKey(conflict.slotKeys), resolution);
  }
  const next = ledger.map((r) =>
    outcome.has(r.key) ? { ...r, resolution: outcome.get(r.key) as ContradictionResolution } : r
  );
  for (const conflict of pendingConflicts(pending)) {
    const key = contradictionKey(conflict.slotKeys);
    if (!next.some((r) => r.key === key)) {
      next.push({
        key,
        slotKeys: conflict.slotKeys,
        resolution: outcome.get(key) as ContradictionResolution,
        raisedAtTurnIndex: pending.raisedAtTurnIndex,
      });
    }
  }
  return next;
}

/** Build the {@link RefinementTrigger} finding shape from a parked pending contradiction. */
function pendingAsFinding(pending: PendingContradiction): ContradictionFinding {
  return {
    slotKeys: pending.slotKeys,
    explanation: pending.explanation,
    severity: 'medium',
    confidence: 1,
    ...(pending.suggestedProbe !== undefined ? { suggestedProbe: pending.suggestedProbe } : {}),
  };
}

/**
 * An answer arrived this turn WITHOUT a typed message: the respondent used a question's in-chat
 * answer control and the card persisted the value itself (P18 question fidelity). It is what
 * separates the two kinds of message-less turn — a tap-to-answer turn, which has a brand-new answer
 * worth checking, from the opening turn, which has nothing to check. Both orchestrators derive this
 * from the same `TurnState` field, so it lives here once rather than at each call site.
 */
export function answerRecordedFrom(state: Pick<TurnState, 'answeredQuestionKey'>): boolean {
  return state.answeredQuestionKey !== undefined;
}

/**
 * Run the contradiction phase over the (post-merge) effective state. `hasMessage` / `answerRecorded` /
 * `disregarded` gate the work; `dataMode` only tweaks the probe's consequence noun;
 * `labels` name the conflicting topics in the probe. The orchestrator passes the same `effective`
 * state it uses for completion + selection.
 */
export async function runContradictionPhase(
  effective: TurnState,
  invokers: CapabilityInvokers,
  opts: {
    hasMessage: boolean;
    /**
     * An answer arrived this turn WITHOUT a typed message: the respondent used a question's in-chat
     * answer control and the card persisted the value itself (P18 question fidelity). It is what
     * separates the two kinds of message-less turn — a tap-to-answer turn, which has a brand-new
     * answer worth checking, from the opening turn, which has nothing to check.
     */
    answerRecorded: boolean;
    disregarded: boolean;
    dataMode: boolean;
    labels: ContradictionProbeLabels;
    /**
     * The answers as they stood BEFORE this turn's extraction merged in (the orchestrator's
     * `state.existingAnswers`, pre-`applyIntents`). Detection runs against THESE, not the merged
     * `effective.existingAnswers`: this turn's contradicting statement is often extracted straight
     * into the conflicting slot (e.g. `satisfaction` 1→5), which would erase the very value the
     * detector needs to see. Comparing the pre-merge answers against the latest message keeps the
     * old value visible so the reversal is caught. Defaults to `effective.existingAnswers`.
     */
    priorAnswers?: ExistingAnswerView[];
  }
): Promise<ContradictionPhaseResult> {
  const base: ContradictionPhaseResult = {
    contradictions: [],
    answerRefinements: [],
    toolCalls: [],
    events: [],
    costUsd: 0,
    suppressWrites: false,
  };

  const ledger = effective.raisedContradictions ?? [];

  // ── Resolution: a probe raised on a PRIOR turn is awaiting this turn's confirmation. ──
  const pending = effective.pendingContradiction;
  if (pending && opts.hasMessage && !opts.disregarded) {
    // Resolve via the refiner — it weighs the confirmation message against the parked conflict and
    // returns a `refine` (apply) or keep decision. Skip fresh detection while resolving.
    const out = await invokers.refineAnswer(effective, {
      contradiction: pendingAsFinding(pending),
    });
    base.costUsd += out.costUsd;
    base.toolCalls.push(
      toolCall(REFINE_ANSWER_CAPABILITY_SLUG, out.diagnostic === undefined, {
        ...(out.diagnostic !== undefined ? { code: out.diagnostic } : {}),
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      })
    );
    base.answerRefinements = out.decisions;
    // Clear the pending state regardless — we asked once; the respondent has had their say. Stamp how
    // each parked conflict ended (a combined probe can cover several) so none is ever re-raised: a
    // conflict whose slot was actually refined → `resolved`; otherwise the original stands → `kept`.
    base.pendingContradiction = null;
    const refinedSlotKeys = new Set(base.answerRefinements.map((d) => d.slotKey));
    base.raisedContradictions = resolvePendingInLedger(ledger, pending, refinedSlotKeys);
    return base;
  }

  // A probe is parked but THIS turn can't answer it — the respondent tapped a card, or the turn was
  // disregarded. Don't detect: stacking a second reconciliation question on top of one they haven't
  // replied to yet is the nagging the ledger exists to prevent, and parking the new finding would
  // overwrite the old one. The parked conflict keeps its `unresolved` ledger entry, so the
  // completion sweep still raises it if the conversation ends without an answer.
  if (pending) return base;

  // ── Detect over the PRE-MERGE answers (see `priorAnswers`) + the latest message. ──
  const allPriorAnswers = opts.priorAnswers ?? effective.existingAnswers;
  const decision = shouldRunDetection(
    effective.config.contradictionMode,
    effective.config.contradictionWindowN,
    'turn',
    {
      everyNTurns: effective.config.contradictionEveryNTurns,
      turnIndex: effective.selectionRound,
    }
  );
  // The configured look-back, applied before the floor so the floor counts what the detector will
  // actually be given. (`shouldRunDetection` returned a `compareWindow` from the first release and
  // every caller ignored it, so "check against the last N answers" silently meant "check against all
  // of them" until 2026-08-30.) The ordering is load-bearing on an answer-vs-answer pass: a window of
  // 1 leaves a single answer with nothing to compare it to, and the floor is what stops that pass.
  const priorAnswers = applyCompareWindow(allPriorAnswers, decision.compareWindow);
  // Floor: with a latest message (fed to the detector as `currentStatement`), ONE stored answer is
  // enough — it can contradict the message. Without one, we need ≥2 answers to compare each other.
  const floor = opts.hasMessage ? 1 : MIN_CONTRADICTION_ANSWERS;
  // What the turn brought: something the respondent typed, or an answer they tapped in. Checking is
  // about the ANSWERS, not about whether they used the keyboard — a respondent working through a
  // questionnaire on answer cards contradicts an earlier answer just as readily as one who types,
  // and gating on the message alone let those sessions through unchecked to the submit-time sweep.
  // The opening turn has neither and is excluded by the same condition, which is what it wants: a
  // form-first session can reach it with answers already stored, and opening the interview by
  // challenging the respondent is not how it should start.
  const somethingToCheck = opts.hasMessage || opts.answerRecorded;
  const canDetect =
    somethingToCheck && !opts.disregarded && decision.run && priorAnswers.length >= floor;
  if (!canDetect) return base;

  // Detect against the pre-merge answers so the conflicting OLD value (which this turn's extraction
  // may already have overwritten in `effective`) is still visible to the detector.
  const detectState: TurnState = { ...effective, existingAnswers: priorAnswers };
  const out = await invokers.detectContradictions(detectState);
  base.costUsd += out.costUsd;
  base.toolCalls.push(
    toolCall(DETECT_CONTRADICTIONS_CAPABILITY_SLUG, out.diagnostic === undefined, {
      ...(out.diagnostic !== undefined ? { code: out.diagnostic } : {}),
      ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
    })
  );
  // Two filters before anything is surfaced:
  //  1. Confidence floor — drop findings the detector isn't sure about (a hedged "could imply"). A
  //     weak guess must never interrupt the respondent; it's kept in `out.findings` for audit only.
  //  2. "Don't nag" — drop any conflict already surfaced this session (by canonical slot-key set),
  //     whether or not it was ever reconciled. A wholly-stale/weak pass ends here (detection still ran,
  //     no user-facing notice). `base.contradictions` reflects what was actually surfaced this turn.
  const raisedKeys = new Set(ledger.map((r) => r.key));
  const fresh = out.findings
    .filter(isSurfaceableContradiction)
    .filter((f) => !raisedKeys.has(contradictionKey(f.slotKeys)));
  base.contradictions = fresh;
  if (fresh.length === 0) return base;

  // ONE informational notice for the whole turn — a single finding shows its explanation; several
  // fresh conflicts are combined into one "I noticed…" box. We ACT ON ALL fresh conflicts this turn
  // (one combined probe) and record EACH in the ledger, so every conflict is genuinely reconciled —
  // not noticed-then-suppressed — and none is ever re-raised once dealt with.
  base.events.push({
    type: 'warning',
    code: 'contradiction',
    message: buildContradictionNoticeMessage(fresh),
  });

  // Ask. Detection running at all means the mode is `probe` (the read path resolves the legacy
  // `flag` to it, and `off` never gets here), so there is one thing to do with a fresh conflict:
  // raise ONE reconciliation question covering every point, suppress this turn's writes, park them
  // all, and record each in the ledger as `unresolved` until the respondent answers next turn.
  //
  // There is deliberately no passive arm any more. `flag` mode used to surface the explanation and
  // let the refiner rewrite the answer in the same breath — an edit the respondent was never asked
  // about and could easily miss. If the detector is confident enough to interrupt, it is the
  // respondent who settles which answer stands, not the model.
  const { text, pending: parked } = buildContradictionProbe({
    findings: fresh,
    statement: effective.userMessage,
    raisedAtTurnIndex: effective.selectionRound,
    labels: opts.labels,
    dataMode: opts.dataMode,
  });
  base.probe = { text, slotKeys: parked.slotKeys };
  base.suppressWrites = true;
  base.pendingContradiction = parked;
  base.raisedContradictions = [
    ...ledger,
    ...fresh.map((f) => raisedEntry(f, 'unresolved', effective.selectionRound)),
  ];
  return base;
}

/** Build the probe labels (slotKey → human topic) from the version's question slots. */
export function questionProbeLabels(questions: TurnState['questions']): ContradictionProbeLabels {
  return { questionLabels: new Map(questions.map((q) => [q.key, q.prompt ?? q.key])) };
}
