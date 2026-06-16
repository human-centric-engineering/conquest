/**
 * Deterministic abuse floor for the seriousness gate (pure).
 *
 * The LLM judge ({@link buildSeriousnessJudgePrompt}) decides nuanced cases, but it is
 * probabilistic: with an earlier disclosure sitting in its recent-conversation context it
 * intermittently reads plain dismissals ("oh just fuck off", "screw you") as the distress of an
 * upset respondent and returns `serious: true`, so clear abuse goes unstruck. Safeguarding-grade
 * reliability for the obvious cases can't rest on that.
 *
 * This net is the non-LLM floor, mirroring the keyword *sensitivity* net: a SHORT message dominated
 * by hostility directed at the interviewer/survey is non-genuine, full stop — struck without
 * consulting the judge. It is deliberately tight:
 *  - It matches only directed-dismissal phrases ("fuck off", "screw you", "piss off", "shut up"…),
 *    never bare insults that can appear inside a genuine complaint ("my boss is an asshole").
 *  - It requires a SHORT message ({@link MAX_ABUSE_WORDS} words) so a *reported* phrase in a longer
 *    sentence ("my manager told me to fuck off") is left to the judge, not struck.
 *  - The orchestrator applies it only when the deterministic HARM floor is silent, so abuse paired
 *    with a genuine disclosure stays protected.
 */

/** Reason recorded when the deterministic floor (not the judge) struck the turn. */
export const ABUSE_NET_REASON = 'The response contains hostile language directed at the survey.';

/**
 * Longest message (in whitespace-delimited words) the floor will act on. Pure dismissals are short
 * ("oh just fuck off" = 4); a longer message that merely contains a hostile phrase is usually a
 * report or a genuine answer, so it is deferred to the judge rather than struck deterministically.
 */
export const MAX_ABUSE_WORDS = 6;

/** Directed-hostility phrases — dismissals aimed at the listener, not bare profanity. */
const HOSTILITY_PATTERNS: RegExp[] = [
  /\bfuck\s*(?:you|off|u|ya|yourself|y'?all|this|that|it|everything)\b/,
  /\bscrew\s+(?:you|off|this|that|it)\b/,
  /\bpiss\s+off\b/,
  /\b(?:sod|bugger|naff)\s+off\b/,
  /\bget\s+(?:lost|stuffed|bent)\b/,
  /\b(?:shut\s+up|shut\s+the\s+fuck\s+up|stfu)\b/,
  /\bgo\s+to\s+hell\b/,
  /\bup\s+yours\b/,
  /\bkiss\s+my\s+(?:ass|arse)\b/,
  /\beat\s+(?:shit|a\s+dick)\b/,
];

/**
 * Returns `{ reason }` when the message is a short, clearly-abusive dismissal directed at the
 * interviewer/survey, otherwise `undefined`. Pure and deterministic — the same string always yields
 * the same result. Callers must still apply harm-floor precedence (don't strike when the message
 * also carries a genuine disclosure).
 */
export function keywordAbuseFloor(message: string): { reason: string } | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;

  // Defer longer messages to the judge — a hostile phrase inside a sentence is usually a report or
  // a genuine answer, not a bare dismissal.
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > MAX_ABUSE_WORDS) return undefined;

  const text = trimmed.toLowerCase();
  return HOSTILITY_PATTERNS.some((re) => re.test(text)) ? { reason: ABUSE_NET_REASON } : undefined;
}
