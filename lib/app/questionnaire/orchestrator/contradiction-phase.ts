/**
 * The shared contradiction phase for both per-turn orchestrators (`runTurn` and `runDataSlotTurn`).
 *
 * Owns the F4.3/F4.4 logic so question mode and data-slot mode behave identically:
 *
 *   - **Resolution** — when a {@link PendingContradiction} is awaiting confirmation (a `probe` was
 *     raised on a PRIOR turn), THIS turn's message is the answer to it: run the refiner against the
 *     parked finding (apply the change on confirm, keep otherwise) and clear the pending state. No
 *     fresh detection runs while resolving.
 *   - **Detect** — otherwise, run the detector (gated by mode/cadence/≥2-answers). On a hit:
 *       - `probe` mode → **defer**: raise a reconciliation question (`contradiction_probe` response),
 *         suppress this turn's writes (nothing is overwritten before the respondent confirms), and
 *         park the finding as a `PendingContradiction`. The blue notice shows the EXPLANATION only.
 *       - `flag` mode → surface the explanation passively AND refine immediately (unchanged).
 *
 * Pure relative to its injected invokers; the orchestrator folds the result into its turn output.
 */

import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  buildContradictionProbe,
  shouldRunDetection,
  type ContradictionProbeLabels,
} from '@/lib/app/questionnaire/contradiction';
import type {
  ContradictionFinding,
  PendingContradiction,
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
 * Run the contradiction phase over the (post-merge) effective state. `hasMessage` / `disregarded`
 * gate the work as in the rest of the pipeline; `dataMode` only tweaks the probe's consequence noun;
 * `labels` name the conflicting topics in the probe. The orchestrator passes the same `effective`
 * state it uses for completion + selection.
 */
export async function runContradictionPhase(
  effective: TurnState,
  invokers: CapabilityInvokers,
  opts: {
    hasMessage: boolean;
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

  // ── Resolution: a probe raised on a PRIOR turn is awaiting this turn's confirmation. ──
  const pending = effective.pendingContradiction;
  if (pending && opts.hasMessage && !opts.disregarded) {
    // Resolve via the refiner — it weighs the confirmation message against the parked conflict and
    // returns a `refine` (apply) or keep decision. Skip fresh detection while resolving.
    if (effective.flags.refinement) {
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
    }
    // Clear the pending state regardless — we asked once; the respondent has had their say.
    base.pendingContradiction = null;
    return base;
  }

  // ── Detect over the PRE-MERGE answers (see `priorAnswers`) + the latest message. ──
  const priorAnswers = opts.priorAnswers ?? effective.existingAnswers;
  const decision = shouldRunDetection(
    effective.config.contradictionMode,
    effective.config.contradictionWindowN,
    'turn',
    {
      everyNTurns: effective.config.contradictionEveryNTurns,
      turnIndex: effective.selectionRound,
    }
  );
  // Floor: with a latest message (fed to the detector as `currentStatement`), ONE stored answer is
  // enough — it can contradict the message. Without one, we need ≥2 answers to compare each other.
  const floor = opts.hasMessage ? 1 : MIN_CONTRADICTION_ANSWERS;
  const canDetect =
    opts.hasMessage &&
    !opts.disregarded &&
    decision.run &&
    effective.flags.contradiction &&
    priorAnswers.length >= floor;
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
  base.contradictions = out.findings;
  if (out.findings.length === 0) return base;

  // The blue notice ALWAYS shows the EXPLANATION (informational) — never the question. Under `probe`
  // mode the reconciliation question is asked as the interviewer's message instead (below).
  for (const finding of out.findings) {
    base.events.push({ type: 'warning', code: 'contradiction', message: finding.explanation });
  }

  const mode = effective.config.contradictionMode;
  if (mode === 'probe') {
    // Defer: ask a reconciliation question, suppress this turn's writes, park the finding. We probe
    // the FIRST finding (the per-turn loop reconciles one conflict at a time).
    const finding = out.findings[0];
    if (finding) {
      const { text, pending: parked } = buildContradictionProbe({
        finding,
        statement: effective.userMessage,
        raisedAtTurnIndex: effective.selectionRound,
        labels: opts.labels,
        dataMode: opts.dataMode,
      });
      base.probe = { text, slotKeys: finding.slotKeys };
      base.suppressWrites = true;
      base.pendingContradiction = parked;
    }
    return base;
  }

  // `flag` mode: surface passively AND refine immediately (unchanged historical behaviour).
  if (effective.flags.refinement) {
    const refine = await invokers.refineAnswer(effective, { contradiction: out.findings[0] });
    base.costUsd += refine.costUsd;
    base.toolCalls.push(
      toolCall(REFINE_ANSWER_CAPABILITY_SLUG, refine.diagnostic === undefined, {
        ...(refine.diagnostic !== undefined ? { code: refine.diagnostic } : {}),
        ...(refine.latencyMs !== undefined ? { latencyMs: refine.latencyMs } : {}),
      })
    );
    base.answerRefinements = refine.decisions;
  }
  return base;
}

/** Build the probe labels (slotKey → human topic) from the version's question slots. */
export function questionProbeLabels(questions: TurnState['questions']): ContradictionProbeLabels {
  return { questionLabels: new Map(questions.map((q) => [q.key, q.prompt ?? q.key])) };
}
