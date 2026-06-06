/**
 * Opening-turn copy for the respondent chat surface (F7.1).
 *
 * The `/messages` turn loop only responds to respondent input (there is no server-side
 * "first question" push and no transcript-replay endpoint), so the surface seeds a single
 * assistant welcome turn. The respondent's first reply triggers the first real question.
 * On resume, the copy acknowledges the returning respondent instead of re-introducing.
 *
 * Pure — the F7.1-PR4 theming layer passes a branded `welcomeCopy`; the platform default
 * mirrors the invitation email's tagline.
 */

import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';

/** Platform-default intro line (matches `SUNRISE_THEME_DEFAULTS.welcomeCopy`). */
export const DEFAULT_WELCOME_COPY =
  "It's a short conversation — answer in your own words and we'll take care of the rest.";

const BEGIN_NUDGE = 'Whenever you’re ready, send a message to begin.';
const RESUME_COPY =
  'Welcome back — your answers so far are saved. Send a message to pick up where we left off.';

/**
 * Build the seed transcript for a session: a single welcome turn for a fresh session, or a
 * resume acknowledgement when answers already exist.
 */
export function buildWelcomeTurns(opts: {
  welcomeCopy?: string;
  resumed?: boolean;
}): QuestionnaireTurn[] {
  if (opts.resumed) {
    return [{ role: 'assistant', content: RESUME_COPY }];
  }
  const intro = opts.welcomeCopy?.trim() || DEFAULT_WELCOME_COPY;
  return [{ role: 'assistant', content: `${intro}\n\n${BEGIN_NUDGE}` }];
}
