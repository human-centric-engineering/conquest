/**
 * Admin report availability — decides what the session drawer's Report tab offers.
 *
 * The re-run affordance only makes sense once a report actually exists; before that the admin should
 * see either a "generate" prompt or an explanation of why a report isn't available yet. Whether a report
 * can be generated for an in-progress session is a QUESTIONNAIRE setting: `allowEarlyFinish` (the
 * respondent may finish early and receive their report before full completion) also gates whether the
 * admin may generate one early. Pure — no I/O — so it is unit-testable and shared by the API + UI.
 */

import type { SessionStatus } from '@/lib/app/questionnaire/types';

export type AdminReportAvailabilityState =
  /** No AI report is configured for this questionnaire — nothing to generate or re-run. */
  | 'disabled'
  /** A report exists (delivered content or a ready revision) — show it + the re-run panel. */
  | 'exists'
  /** No report yet, but one can be generated now — offer "Generate report". */
  | 'generate'
  /** No report yet and not eligible to generate — explain why (no button). */
  | 'not_yet';

export interface AdminReportAvailability {
  state: AdminReportAvailabilityState;
  /** Human-readable explanation for the `disabled` / `not_yet` / `generate` states. */
  message: string;
}

export function resolveAdminReportAvailability(input: {
  /** The version's report feature is on AND in an AI mode (raw/disabled produce no AI report). */
  enabled: boolean;
  /** A delivered report has content, or at least one revision is `ready`. */
  hasReport: boolean;
  /** A report is currently generating (`queued`/`processing`) — treated as existing (show its status). */
  reportInFlight?: boolean;
  sessionStatus: SessionStatus;
  /** Answered question slots — used to avoid offering generation on an empty session. */
  answeredCount: number;
  /** The questionnaire allows the respondent to finish (and get a report) early. */
  allowEarlyFinish: boolean;
}): AdminReportAvailability {
  const { enabled, hasReport, reportInFlight, sessionStatus, answeredCount, allowEarlyFinish } =
    input;

  // A report that exists — or is already being generated — shows the report panel, not a prompt.
  if (hasReport || reportInFlight) return { state: 'exists', message: '' };

  if (!enabled) {
    return {
      state: 'disabled',
      message: 'This questionnaire isn’t configured to produce an AI report.',
    };
  }

  // A completed session should have a report; if it doesn't (never generated, or generation failed),
  // the admin can generate one on demand.
  if (sessionStatus === 'completed') {
    return { state: 'generate', message: 'This session is complete but has no report yet.' };
  }

  // In progress: a report can only be generated early when the questionnaire allows early finishing
  // AND there is at least one captured answer to report on.
  if (allowEarlyFinish && answeredCount > 0) {
    return {
      state: 'generate',
      message:
        'The session is still in progress. You can generate a report from the answers captured so far (it may be partial).',
    };
  }

  return {
    state: 'not_yet',
    message: allowEarlyFinish
      ? 'No answers have been captured yet — a report will be available once the respondent has answered something.'
      : 'A report becomes available once the respondent completes this session.',
  };
}
