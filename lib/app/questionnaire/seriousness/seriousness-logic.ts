/**
 * Seriousness / abuse gate — the pure escalation + strike logic.
 *
 * Two pure exports, no Prisma / Next:
 *  - {@link seriousnessGateActive} — whether the gate runs at all (a positive per-questionnaire
 *    threshold).
 *  - {@link evaluateAbuseStrike} — fold one non-serious answer into the session's strike count
 *    and decide: escalating warning, or abandon at the threshold. Pure: count in → decision out,
 *    so it's zero-mock unit-testable and the orchestrator stays deterministic.
 *
 * Escalation (default threshold 4): strikes 1..3 surface a warning that firms up as the abandon
 * point nears (the last warning before abandon is the most direct); the 4th abandons the session.
 */

import type { AbuseStrikeOutcome } from '@/lib/app/questionnaire/seriousness/types';

/**
 * The deterministic final message streamed when the session is **aborted** for repeated abuse —
 * generic fallback used only when no strike count is available (the orchestrator normally streams
 * the counted {@link abuseAbortMessage}). Kept under its original export name so callers' `??`
 * fallbacks are unchanged.
 */
export const ABUSE_ABANDON_MESSAGE =
  'This session has been recorded as aborted after repeated answers that seemed abusive or ' +
  'lacking in sincerity. Thank you for your time.';

/**
 * The deterministic final message streamed when the session is aborted, naming how many non-genuine
 * answers were recorded (`count` = the strike count at abort, i.e. the threshold). Singular-aware so
 * a threshold of 1 still reads correctly.
 */
export function abuseAbortMessage(count: number): string {
  if (count === 1) {
    return (
      'There has now been 1 occasion where your answer seemed to be abusive or lacking in ' +
      'sincerity so I must now record this session as aborted.'
    );
  }
  return (
    `There have now been ${count} occasions where your answers seemed to be abusive or lacking ` +
    'in sincerity so I must now record this session as aborted.'
  );
}

/**
 * Whether the gate is live for a turn: the questionnaire must tolerate fewer than `Infinity`
 * strikes (`threshold > 0`; `0` = off for this questionnaire).
 *
 * This previously also AND-ed a platform feature flag, which no longer exists. The orchestrator
 * checks `config.abuseThreshold > 0` inline rather than calling this, so the helper is kept only
 * as the named statement of the rule — if you wire it up, that is the whole rule.
 */
export function seriousnessGateActive(threshold: number): boolean {
  return threshold > 0;
}

/**
 * Escalating, polite warning copy for a non-serious answer that did NOT yet hit the threshold.
 * `remaining` = strikes left before abandonment (≥1 here). The last warning (`remaining === 1`)
 * is the most direct — it names the consequence — while earlier ones stay gentle. All make the
 * "doesn't seem serious → setting it aside" point the product requires.
 */
function warningCopy(remaining: number): string {
  if (remaining <= 1) {
    // Penultimate strike: the final sentence is wrapped in **bold** (the notice renders it) so the
    // last-chance consequence stands out, and the orchestrator flags it `final` so the notice turns
    // red. The copy is a blunt last warning: one more infringement aborts the conversation.
    return (
      "Your previous answer didn't seem serious, so I've set it aside. " +
      '**Final warning: one more inappropriate answer and this conversation will be aborted.**'
    );
  }
  return (
    "Your previous answer didn't seem serious, so I'll set it aside for now. " +
    'Please try to keep the conversation on topic and sincere.'
  );
}

/**
 * Record one non-serious answer against the session's prior strike count and decide what happens.
 * Pure. `threshold > 0` is assumed (the caller checks {@link seriousnessGateActive} first).
 */
export function evaluateAbuseStrike(priorStrikes: number, threshold: number): AbuseStrikeOutcome {
  const newStrikeCount = priorStrikes + 1;
  if (newStrikeCount >= threshold) {
    return {
      newStrikeCount,
      abandon: true,
      noticeMessage: '',
      final: false,
      abandonMessage: abuseAbortMessage(newStrikeCount),
    };
  }
  const remaining = threshold - newStrikeCount;
  return {
    newStrikeCount,
    abandon: false,
    noticeMessage: warningCopy(remaining),
    // The last warning before abandonment (only one strike left) — surfaced in a firmer red notice.
    final: remaining <= 1,
  };
}
