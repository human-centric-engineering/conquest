/**
 * Seriousness / abuse gate — the pure escalation + strike logic.
 *
 * Two pure exports, no Prisma / Next:
 *  - {@link seriousnessGateActive} — whether the gate runs at all (platform flag + a positive
 *    per-questionnaire threshold).
 *  - {@link evaluateAbuseStrike} — fold one non-serious answer into the session's strike count
 *    and decide: escalating warning, or abandon at the threshold. Pure: count in → decision out,
 *    so it's zero-mock unit-testable and the orchestrator stays deterministic.
 *
 * Escalation (default threshold 4): strikes 1..3 surface a warning that firms up as the abandon
 * point nears (the last warning before abandon is the most direct); the 4th abandons the session.
 */

import type { AbuseStrikeOutcome } from '@/lib/app/questionnaire/seriousness/types';

/** The deterministic final message streamed to the respondent when the session is abandoned. */
export const ABUSE_ABANDON_MESSAGE =
  "Several answers haven't seemed genuine, so we've had to end this session here. " +
  'Thank you for your time.';

/**
 * Whether the gate is live for a turn: the platform sub-feature flag must be on AND the
 * questionnaire must tolerate fewer than `Infinity` strikes (`threshold > 0`; `0` = off).
 */
export function seriousnessGateActive(flagEnabled: boolean, threshold: number): boolean {
  return flagEnabled && threshold > 0;
}

/**
 * Escalating, polite warning copy for a non-serious answer that did NOT yet hit the threshold.
 * `remaining` = strikes left before abandonment (≥1 here). The last warning (`remaining === 1`)
 * is the most direct — it names the consequence — while earlier ones stay gentle. All make the
 * "doesn't seem serious → setting it aside" point the product requires.
 */
function warningCopy(remaining: number): string {
  if (remaining <= 1) {
    return (
      "That still doesn't seem like a serious answer, so I'll have to set it aside. " +
      "Please note: if it happens again I'll have to end this session. " +
      'Could you answer the question genuinely?'
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
      abandonMessage: ABUSE_ABANDON_MESSAGE,
    };
  }
  return {
    newStrikeCount,
    abandon: false,
    noticeMessage: warningCopy(threshold - newStrikeCount),
  };
}
