/**
 * Contradiction normalisation + the pure detection scheduler (F4.3).
 *
 * Two pure, data-in / data-out exports, no Prisma / Next:
 *
 *  1. {@link normalizeContradictionFindings} — the F4.3 analogue of F4.2's
 *     `normalizeAnswerIntents`. Takes the LLM-reported contradictions (already
 *     schema-valid) plus the {@link ContradictionContext} and returns the coherent
 *     {@link ContradictionFinding}s to surface, dropping an individual odd finding
 *     rather than failing the whole pass. Jobs:
 *       - Resolve every `slotKey` to a real slot AND an *answered* one (you can't
 *         contradict an unanswered slot) — else drop.
 *       - Require ≥2 distinct slots after de-duplicating the key list — else drop.
 *       - Clamp severity defensively (the schema enums it; this guards direct/CLI
 *         callers that bypass Zod).
 *       - Mode-shape: `flag` strips any probe (it surfaces passively); `probe`
 *         keeps the probe, but a missing/blank probe *downgrade-keeps* the finding
 *         without one rather than dropping it — the conflict is still real (the
 *         analogue of F4.2 downgrading a quote-less `direct` to `inferred`).
 *       - De-duplicate symmetric findings: `[a,b]` and `[b,a]` are the same
 *         conflict; key on the sorted slot-key set, keep the highest confidence.
 *
 *  2. {@link shouldRunDetection} — the mode-aware scheduler. No session/turn
 *     machinery exists pre-F4.6, so this is the pure decision the future engine
 *     calls: should this pass run, and how much history to compare. Kept in the
 *     core so it's zero-mock unit-testable and reusable by the F4.6 engine.
 */

import type { ContradictionMode } from '@/lib/app/questionnaire/types';
import type { DetectedContradiction } from '@/lib/app/questionnaire/contradiction/detection-schema';
import {
  CONTRADICTION_SEVERITIES,
  type ContradictionContext,
  type ContradictionDetectionResult,
  type ContradictionFinding,
  type ContradictionSeverity,
  type DetectionDecision,
  type DetectionPhase,
  type DroppedFinding,
  type FindingsSummary,
} from '@/lib/app/questionnaire/contradiction/types';

const SEVERITY_SET: ReadonlySet<string> = new Set(CONTRADICTION_SEVERITIES);

/**
 * Minimum detector `confidence` for a finding to be SURFACED to the respondent (a probe / notice / a
 * submit-time hold). Below this the detector isn't sure the answers are genuinely at odds — a hedged
 * "could imply a different understanding" guess — and interrupting the respondent over it does more
 * harm than good, so it is silently dropped from the respondent-facing paths. It is NOT a detection
 * gate: {@link normalizeContradictionFindings} still returns weak findings (the admin preview shows
 * them); only the live surfacing paths (per-turn phase + completion sweep) apply this floor. Sits below
 * `CLEAR_CONTRADICTION_CONFIDENCE` (0.8), so `[floor, 0.8)` surfaces humbly and `≥ 0.8` surfaces
 * directly.
 */
export const SURFACE_CONTRADICTION_CONFIDENCE = 0.7;

/** Whether a finding is confident enough to raise with the respondent — see the constant above. */
export function isSurfaceableContradiction(finding: { confidence: number }): boolean {
  return finding.confidence >= SURFACE_CONTRADICTION_CONFIDENCE;
}

/** Stable de-duplication of a key list, preserving first-seen order. */
function distinctKeys(keys: string[]): string[] {
  return [...new Set(keys)];
}

/**
 * Canonical key for a contradiction: its slot-key *set*, so `[a,b]` ≡ `[b,a]`. Used both to dedupe
 * symmetric findings here and, downstream, as the stable identity of a {@link RaisedContradiction} in
 * the session ledger (so the same conflict is never re-raised once dealt with).
 */
export function contradictionKey(slotKeys: string[]): string {
  return [...slotKeys].sort().join('|');
}

/**
 * Normalise the detector's reported contradictions against the context. See the
 * module doc. Returns the coherent findings to surface plus the records removed
 * (with reasons) for logging.
 */
export function normalizeContradictionFindings(
  contradictions: DetectedContradiction[],
  ctx: ContradictionContext
): ContradictionDetectionResult {
  const dropped: DroppedFinding[] = [];
  const knownKeys = new Set(ctx.slots.map((s) => s.key));
  const answeredKeys = new Set(ctx.answers.map((a) => a.slotKey));

  // First pass: resolve + shape into candidate findings.
  const candidates: ContradictionFinding[] = [];
  for (const c of contradictions) {
    const keys = distinctKeys(c.slotKeys);

    const unknown = keys.filter((k) => !knownKeys.has(k));
    if (unknown.length > 0) {
      dropped.push({ slotKeys: keys, reason: `unknown slot key(s): ${unknown.join(', ')}` });
      continue;
    }

    const unanswered = keys.filter((k) => !answeredKeys.has(k));
    if (unanswered.length > 0) {
      dropped.push({ slotKeys: keys, reason: `unanswered slot key(s): ${unanswered.join(', ')}` });
      continue;
    }

    // A contradiction normally needs at least two distinct slots. But when the caller
    // supplied the respondent's latest message (`currentStatement`), that message is the
    // implicit second party — so a single stored slot the message reverses IS a real
    // contradiction (the same-slot reversal case). Require ≥1 distinct slot then, ≥2 otherwise.
    const minSlots = ctx.currentStatement ? 1 : 2;
    if (keys.length < minSlots) {
      dropped.push({
        slotKeys: keys,
        reason: minSlots === 1 ? 'no slot referenced' : 'fewer than two distinct slots',
      });
      continue;
    }

    // Clamp severity defensively — the schema already enums it, but a direct
    // caller (test, CLI) can bypass Zod, so fall back to the middle band.
    const severity: ContradictionSeverity = SEVERITY_SET.has(c.severity) ? c.severity : 'medium';

    const finding: ContradictionFinding = {
      slotKeys: keys,
      explanation: c.explanation,
      severity,
      confidence: c.confidence,
    };

    // Mode shaping. `flag` surfaces passively → never carries a probe. `probe`
    // carries a reconciliation question, but a missing/blank one doesn't drop the
    // finding (the conflict stands) — it's kept without a probe.
    if (ctx.mode === 'probe') {
      const probe = typeof c.suggestedProbe === 'string' ? c.suggestedProbe.trim() : '';
      if (probe.length > 0) finding.suggestedProbe = probe;
    }

    candidates.push(finding);
  }

  // Second pass: de-duplicate symmetric findings, keeping the highest confidence.
  // Higher confidence wins; an exact tie keeps the first seen (stable).
  const best = new Map<string, ContradictionFinding>();
  for (const finding of candidates) {
    const key = contradictionKey(finding.slotKeys);
    const incumbent = best.get(key);
    if (!incumbent) {
      best.set(key, finding);
      continue;
    }
    if (finding.confidence > incumbent.confidence) {
      best.set(key, finding);
      dropped.push({
        slotKeys: incumbent.slotKeys,
        reason: 'duplicate contradiction, lower confidence',
      });
    } else {
      dropped.push({
        slotKeys: finding.slotKeys,
        reason: 'duplicate contradiction, lower confidence',
      });
    }
  }

  return { findings: [...best.values()], dropped };
}

/**
 * Decide whether a detection pass runs and how much history to compare — pure,
 * the seam the F4.6 engine calls per turn and at completion.
 *
 *  - `mode: 'off'` → never run.
 *  - `phase: 'completion-sweep'` → always run, comparing **all** answers (the final
 *    pass before submit must be thorough regardless of the window or cadence — the
 *    last gate before submit is never skipped).
 *  - `phase: 'turn'` → run on a turn boundary; compare the most recent `windowN`
 *    answers (or all when `windowN <= 0`). `windowN` is a *comparison window* (how
 *    much history to check); the optional `cadence` is the *interval* (how often to
 *    run): with `everyNTurns > 1`, a turn runs detection only when its zero-based
 *    `turnIndex` is a multiple of `everyNTurns` (so N=2 → turns 0, 2, 4…). Omitted
 *    cadence (or `everyNTurns <= 1`) means every turn.
 */
export function shouldRunDetection(
  mode: ContradictionMode,
  windowN: number,
  phase: DetectionPhase,
  cadence?: { everyNTurns: number; turnIndex: number }
): DetectionDecision {
  if (mode === 'off') return { run: false, compareWindow: 'all' };
  if (phase === 'completion-sweep') return { run: true, compareWindow: 'all' };
  // Turn phase: honour the cadence interval when one is supplied.
  if (cadence && cadence.everyNTurns > 1 && cadence.turnIndex % cadence.everyNTurns !== 0) {
    return { run: false, compareWindow: windowN > 0 ? windowN : 'all' };
  }
  return { run: true, compareWindow: windowN > 0 ? windowN : 'all' };
}

/**
 * Roll a finding list up into the counts-only {@link FindingsSummary} — the single
 * source of truth for both the preview route's `summary` field and the capability's
 * PII-safe `redactProvenance` preview, so the two can't drift. Carries no
 * values/explanations/probes.
 */
export function summarizeFindings(
  findings: ContradictionFinding[],
  droppedCount: number
): FindingsSummary {
  const severityCounts: Record<string, number> = {};
  for (const finding of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
  }
  return {
    findingCount: findings.length,
    probeCount: findings.filter((f) => typeof f.suggestedProbe === 'string').length,
    droppedCount,
    severityCounts,
  };
}
