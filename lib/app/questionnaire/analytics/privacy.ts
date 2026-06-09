/**
 * Analytics privacy primitives (F8.3 anonymous-mode hardening).
 *
 * The single source of truth for the k-anonymity low-N suppression threshold the
 * three analytics aggregators share. Pure and **client-safe** (no Prisma, no Next),
 * so the `'use client'` admin panels import {@link K_ANONYMITY_THRESHOLD} to label a
 * suppressed surface with the same number the aggregators gate on.
 *
 * The rule (see `.context/app/questionnaire/anonymous-mode.md`): a version's granular
 * analytics detail — per-question distributions, funnel stage counts, the
 * top-spend-session table — is withheld until the cohort reaches the threshold, so a
 * tiny sample can't re-identify an individual respondent. Suppression is applied at
 * the **data boundary** (the aggregator), never just in the UI.
 */

/**
 * Minimum cohort size before granular analytics detail is surfaced. Below this many
 * (non-preview) sessions, the aggregators withhold per-respondent-shaped detail. `5`
 * is the conventional small-cell suppression floor for internal analytics.
 */
export const K_ANONYMITY_THRESHOLD = 5;

/**
 * Whether a cohort of `total` sessions is small enough to suppress granular detail.
 * True only for a non-empty cohort below the threshold — an empty cohort (`0`) is not
 * "suppressed", it genuinely has no data, and a cohort at/above the threshold is safe
 * to surface.
 */
export function isCohortSuppressed(total: number): boolean {
  return total > 0 && total < K_ANONYMITY_THRESHOLD;
}
