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
 * Assemble the verbatim support-signpost message: the admin-authored copy with the optional
 * resource URL appended. Pure string assembly so both orchestrators share one definition.
 */
export function composeSupportMessage(message: string, resourceUrl: string): string {
  const url = resourceUrl.trim();
  const body = message.trim();
  return url.length > 0 ? `${body} ${url}` : body;
}
