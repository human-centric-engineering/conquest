/**
 * Opening-turn copy for the respondent chat surface (F7.1).
 *
 * The surface seeds a single assistant welcome turn (the branded intro). On a fresh session
 * the surface then auto-fires a *kickoff* turn (see {@link SessionWorkspace}'s `autoStart`),
 * so the agent proactively streams the first question right after the greeting — the
 * respondent never has to "send a message to begin". On resume the copy acknowledges the
 * returning respondent and asks them to send a message (no kickoff: replaying transcript /
 * re-asking on every refresh would burn an LLM turn each load).
 *
 * Pure — the F7.1-PR4 theming layer passes a branded `welcomeCopy`; the platform default
 * mirrors the invitation email's tagline.
 */

import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

/** Platform-default intro line (matches `SUNRISE_THEME_DEFAULTS.welcomeCopy`). */
export const DEFAULT_WELCOME_COPY =
  "It's a short conversation — answer in your own words and we'll take care of the rest.";

const RESUME_COPY =
  'Welcome back — your answers so far are saved. Send a message to pick up where we left off.';

/**
 * Build the seed transcript for a session: the branded intro for a fresh session (the
 * proactive first question is then streamed by the auto-kickoff turn), or a resume
 * acknowledgement when answers already exist.
 */
export function buildWelcomeTurns(opts: {
  welcomeCopy?: string;
  resumed?: boolean;
}): QuestionnaireTurn[] {
  if (opts.resumed) {
    return [{ role: 'assistant', content: RESUME_COPY }];
  }
  const intro = opts.welcomeCopy?.trim() || DEFAULT_WELCOME_COPY;
  return [{ role: 'assistant', content: intro }];
}
