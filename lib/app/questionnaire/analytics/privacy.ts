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

import { IS_ALPHA } from '@/lib/app/release-stage';

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

/**
 * ALPHA (temporary): while the product is in the `alpha` release stage ({@link IS_ALPHA}, driven by the
 * existing `NEXT_PUBLIC_RELEASE_STAGE`), the analytics **dashboard** panels (completion funnel, question
 * distributions, per-session cost) bypass the low-N k-anonymity suppression so the team can see analytics
 * on the tiny test cohorts alpha produces. NOT a dedicated flag — tied to the release stage so it
 * **auto-restores** the moment the stage moves off `alpha` for GA, with no code change or cleanup.
 *
 * Deliberately scoped to the dashboard only: cohort reports (`cohort-report/dataset.ts`), safeguarding
 * alerts (`analytics/safeguarding.ts`), and the data-slot material floor still enforce k-anonymity via
 * {@link isCohortSuppressed}/{@link K_ANONYMITY_THRESHOLD}. The admin analytics view shows a visible
 * "disabled for alpha testing" note whenever this is active. See
 * `.context/app/questionnaire/anonymous-mode.md`.
 */
export const ALPHA_ANALYTICS_ANONYMITY_DISABLED = IS_ALPHA;

/**
 * Low-N suppression decision for the analytics **dashboard** panels. Identical to
 * {@link isCohortSuppressed} except it honours the temporary {@link ALPHA_ANALYTICS_ANONYMITY_DISABLED}
 * bypass. Use this (not `isCohortSuppressed`) only for the funnel / distributions / cost dashboard
 * surfaces; keep `isCohortSuppressed` for every other k-anonymity gate.
 */
export function isAnalyticsPanelSuppressed(total: number): boolean {
  if (ALPHA_ANALYTICS_ANONYMITY_DISABLED) return false;
  return isCohortSuppressed(total);
}
