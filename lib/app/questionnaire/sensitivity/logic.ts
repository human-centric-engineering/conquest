/**
 * Sensitivity awareness — the pure severity + signpost logic.
 *
 * Three pure exports, no Prisma / Next:
 *  - {@link severityRank} — orders the severities so a running max can be computed.
 *  - {@link runningMaxLevel} — fold a turn's severity into the session's prior level (never
 *    downgrades; absence of a prior level means this turn's severity becomes the level).
 *  - {@link shouldSignpost} — whether THIS turn first reaches `high` (so the support signpost fires
 *    exactly once per session, with no extra column — see the orchestrator step).
 */

import type { SensitivitySeverity } from '@/lib/app/questionnaire/types';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';

/**
 * The fallback support-signpost copy, used when sensitivity awareness is on but the admin hasn't
 * authored a `supportMessage`. A fixed, reviewed string (NOT LLM-generated), so the safeguarding
 * wording is always safe + exact while removing the footgun where toggling sensitivity on with no
 * authored copy silently produced no signpost. An admin can still override it with their own copy.
 */
export const DEFAULT_SUPPORT_MESSAGE =
  'Thank you for sharing that — it sounds difficult, and you don’t have to deal with it alone. ' +
  'Confidential support is available whenever you need it, and you can take a break or stop at any time.';

/** The effective signpost copy: the admin's authored message, or {@link DEFAULT_SUPPORT_MESSAGE}. */
export function effectiveSupportMessage(authored: string): string {
  const trimmed = authored.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SUPPORT_MESSAGE;
}

/** Numeric order for the severities (low < medium < high), for running-max comparison. */
export function severityRank(severity: SensitivitySeverity): number {
  switch (severity) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
  }
}

/**
 * The session's severity level after folding in this turn's `severity`. Monotonic — it only ever
 * rises (a later, milder disclosure never lowers a session already flagged higher). A null prior
 * level (nothing flagged yet) yields this turn's severity.
 */
export function runningMaxLevel(
  prior: SensitivitySeverity | null | undefined,
  next: SensitivitySeverity
): SensitivitySeverity {
  if (!prior) return next;
  return severityRank(next) > severityRank(prior) ? next : prior;
}

/**
 * Whether the support signpost should fire for THIS turn: a serious (`high`) disclosure that the
 * session had not already reached. Because the route persists the running level after the first
 * high turn, `prior` is `'high'` on every later turn — so this returns true exactly once per
 * session, with no dedicated dedupe column. Fail-open: if the persist write ever fails, a later
 * high turn may re-signpost, which is safer than silently dropping the safeguarding message.
 */
export function shouldSignpost(
  prior: SensitivitySeverity | null | undefined,
  severity: SensitivitySeverity
): boolean {
  return severity === 'high' && prior !== 'high';
}

/**
 * Combine the per-turn sensitivity signals (extractor field, dedicated detector, keyword net) into
 * one assessment. Detection is defence-in-depth: ANY signal that fired means a disclosure, so a
 * miss by one source is caught by another. The strongest severity wins; on a tie the EARLIER
 * argument wins, so pass the LLM-derived signals (which carry a better category/summary) before the
 * keyword net. Returns `undefined` when no signal fired. Pure — both orchestrators share it.
 */
export function mergeSensitivitySignals(
  ...signals: Array<SensitivityAssessment | null | undefined>
): SensitivityAssessment | undefined {
  let best: SensitivityAssessment | undefined;
  for (const signal of signals) {
    if (!signal) continue;
    if (!best || severityRank(signal.severity) > severityRank(best.severity)) {
      best = signal;
    }
  }
  return best;
}

/**
 * Assemble the verbatim support-signpost message: the admin-authored copy with the optional
 * resource URL appended. Pure string assembly so both orchestrators share one definition.
 */
export function composeSupportMessage(message: string, resourceUrl: string): string {
  const url = resourceUrl.trim();
  const body = message.trim();
  return url.length > 0 ? `${body} ${url}` : body;
}
