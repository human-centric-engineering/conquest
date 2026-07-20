/**
 * The k-anonymity gate for meeting insights (P15.5).
 *
 * A synthesis is read ALOUD to the room it came from. That is the whole threat model, and it is
 * unlike every other report in this system: the audience and the subjects are the same people,
 * sitting together, and they know who said what about each other five minutes ago.
 *
 * So "a tension between two of you" is not anonymous. Everybody present can do the arithmetic.
 * `insightMinSupport` defaults to 3 and floors at 2 because three is the smallest group where a
 * finding stops pointing at identifiable individuals. Mirrors the floor the round learning digest
 * already applies.
 *
 * Pure — no Prisma, no I/O. Applied at GENERATION (so a suppressed finding is never written) and
 * again on READ (so raising the setting after a meeting makes the existing synthesis safer without
 * regenerating it).
 */

import type { MeetingInsightView } from '@/lib/app/questionnaire/experiences/meeting/types';

/**
 * Whether a finding rests on enough people to be safe to say out loud.
 *
 * The comparison is `>=`, and `minSupport` is trusted to have been narrowed already
 * (`narrowExperienceSettings` clamps it to the floor). A caller passing a raw, un-narrowed number
 * could pass 0 or 1 — hence the defensive floor below rather than trusting the input.
 */
export function meetsSupportThreshold(supportCount: number, minSupport: number): boolean {
  // Never honour a threshold below 2, whatever the caller says. A setting of 1 or 0 would mean
  // "publish findings that rest on one person", which in a room of colleagues is an attribution.
  const floor = Math.max(2, Math.floor(minSupport));
  return supportCount >= floor;
}

/**
 * Drop every finding that cannot be safely said aloud.
 *
 * Suppression is SILENT by design where respondents are concerned, but the facilitator's own view
 * reports the count (see {@link summariseSuppression}) — an operator should know their synthesis
 * was thinned, or they will read the gaps as "the room agreed about everything".
 */
export function applySupportGate<T extends { supportCount: number }>(
  insights: readonly T[],
  minSupport: number
): T[] {
  return insights.filter((i) => meetsSupportThreshold(i.supportCount, minSupport));
}

/**
 * What was withheld, for the facilitator's benefit only.
 *
 * Deliberately reports only a COUNT, never the suppressed statements themselves — a facilitator
 * who could read them would be reading exactly the attributable findings the gate exists to
 * prevent, and in a small room they would be able to place them.
 */
export function summariseSuppression<T extends { supportCount: number }>(
  insights: readonly T[],
  minSupport: number
): { shown: number; withheld: number } {
  const shown = applySupportGate(insights, minSupport).length;
  return { shown, withheld: insights.length - shown };
}

/**
 * The respondent-facing subset: gated by support AND by the per-insight visibility flag.
 *
 * Both conditions, never either — `visibleToRespondents` is a facilitator's editorial choice about
 * what is useful to share, and it must not be able to override the safety gate. A facilitator
 * ticking "show this" on a two-person tension would otherwise publish an attribution.
 */
export function respondentVisibleInsights(
  insights: readonly MeetingInsightView[],
  minSupport: number
): MeetingInsightView[] {
  return applySupportGate(insights, minSupport).filter((i) => i.visibleToRespondents);
}
