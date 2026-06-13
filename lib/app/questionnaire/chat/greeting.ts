/**
 * Opening-turn copy for the respondent chat surface (F7.1).
 *
 * The surface seeds a single assistant welcome turn: the branded intro followed by a short
 * pre-flight guidance paragraph (answer honestly; talk via the mic if voice is on; the
 * questionnaire is anonymous if it is). On a fresh session the surface then auto-fires a
 * *kickoff* turn (see {@link SessionWorkspace}'s `autoStart`), so the agent proactively
 * streams the first question right after the greeting — the respondent never has to "send a
 * message to begin". The guidance is folded into the *same* turn (a `\n\n` markdown break)
 * rather than a second turn, because the kickoff guard fires only while a single greeting
 * turn is present; a second turn would suppress the proactive first question.
 *
 * On resume the copy acknowledges the returning respondent and asks them to send a message
 * (no kickoff: replaying transcript / re-asking on every refresh would burn an LLM turn each
 * load). Resume skips the pre-flight guidance — the respondent already saw it when they began.
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

/** Universal pre-flight advice — shown on every fresh session, regardless of config. */
export const HONESTY_GUIDANCE = 'Answer honestly — there are no right or wrong answers.';

/** Shown only when voice input is enabled (F6.2 mic affordance). */
export const VOICE_GUIDANCE =
  'You can type your replies, or tap the mic button to talk through your answers naturally.';

/** Shown only when the questionnaire is configured `anonymousMode` (identity is redacted). */
export const ANONYMOUS_GUIDANCE =
  "This questionnaire is anonymous, so your name and details won't be passed on.";

/**
 * Compose the pre-flight guidance line for a fresh session: honesty advice always, plus the
 * mic nudge and anonymity reassurance when each applies. Joined into one sentence-flow string.
 */
function buildGuidanceCopy(opts: { voiceInputEnabled?: boolean; anonymous?: boolean }): string {
  const parts = [HONESTY_GUIDANCE];
  if (opts.voiceInputEnabled) parts.push(VOICE_GUIDANCE);
  if (opts.anonymous) parts.push(ANONYMOUS_GUIDANCE);
  return parts.join(' ');
}

/**
 * Build the seed transcript for a session: the branded intro plus pre-flight guidance for a
 * fresh session (the proactive first question is then streamed by the auto-kickoff turn), or
 * a resume acknowledgement when answers already exist.
 */
export function buildWelcomeTurns(opts: {
  welcomeCopy?: string;
  resumed?: boolean;
  voiceInputEnabled?: boolean;
  anonymous?: boolean;
}): QuestionnaireTurn[] {
  if (opts.resumed) {
    return [{ role: 'assistant', content: RESUME_COPY }];
  }
  const intro = opts.welcomeCopy?.trim() || DEFAULT_WELCOME_COPY;
  return [{ role: 'assistant', content: `${intro}\n\n${buildGuidanceCopy(opts)}` }];
}
