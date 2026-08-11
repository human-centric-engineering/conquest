/**
 * Reopen eligibility — pure decider (F-early-finish-reopen).
 *
 * Whether a `completed` session may go back to `active` via the respondent's "Continue
 * answering" control on the report screen. Deliberately narrow and separate from the
 * F4.6 state machine: `classifyTransition('completed', 'active')` stays `illegal`
 * unconditionally (see `session/types.ts`), and this function is the ONLY gate the
 * reopen seam (`reopenSession`, `app/api/v1/app/questionnaires/_lib/sessions.ts`) may
 * rely on before writing the exception.
 *
 * Pure, data-in/data-out like the rest of the session core — the impure reads (current
 * config, experience-leg membership, the latest `completed` event's `reason`) live at
 * the route seam (`app/api/v1/app/questionnaire-sessions/_lib/reopen-eligibility.ts`).
 */

import type { SessionStatus } from '@/lib/app/questionnaire/types';

export interface ReopenEligibilityInput {
  status: SessionStatus;
  /** The version's CURRENT `allowEarlyFinish` value — not a snapshot from the original early finish. */
  allowEarlyFinish: boolean;
  /** Whether this session is a leg of an experience run (never resumable — see run-advance). */
  isExperienceLeg: boolean;
  /**
   * The `reason` recorded on the most recent `completed`-type `AppQuestionnaireSessionEvent`, or
   * `null` if none exists. Only `'respondent_early_finish'` unlocks reopen — a naturally-completed
   * session (`'respondent_submit'`) stays terminal.
   */
  latestCompletedReason: string | null;
}

/**
 * `completed`, the early-finish escape hatch still enabled, not an experience leg, and the
 * respondent's most recent completion was genuinely early (not a full natural submit).
 */
export function isReopenEligible(input: ReopenEligibilityInput): boolean {
  return (
    input.status === 'completed' &&
    input.allowEarlyFinish &&
    !input.isExperienceLeg &&
    input.latestCompletedReason === 'respondent_early_finish'
  );
}
