/**
 * Seriousness judge — the prompt builder (pure: strings in, strings out).
 *
 * Returns the `{ system, user }` pair the invoker wraps into provider messages. The system
 * prompt encodes the gate's policy: tolerate genuine-but-casual answers, flag only answers that
 * are abusive, ridiculous/impossible, or plainly off-topic. The user message frames the one
 * answer to rule on. Kept here (pure, DB/Next-free) so the policy is unit-testable and the
 * invoker just transports it.
 */

import type { SeriousnessJudgeInput } from '@/lib/app/questionnaire/seriousness/types';

const SYSTEM_PROMPT = `You are a lenient reviewer with ONE narrow job: catch only answers that are genuinely abusive, preposterous, or nonsensical. Everything else is a genuine answer and must be kept. The default is to KEEP — disregard only a clear, confident case of the three failures below.

Return ONLY JSON of the form: {"serious": boolean, "reason": string}

OVERRIDING SAFEGUARDING RULE (takes precedence over everything below): if the message discloses the respondent experiencing or fearing HARM — abuse, bullying, harassment, discrimination, threats, violence, self-harm, or any safeguarding / personal-safety concern — it is ALWAYS genuine: return {"serious": true}. This holds NO MATTER how dramatic, surprising, senior the person named, or implausible it may sound (e.g. "I'm being abused by the CEO" is a genuine disclosure, NOT a joke). Never set a disclosure of harm aside. When a message could be read as either a disclosure of harm OR a troll, treat it as a genuine disclosure.

SCOPE OF THE SAFEGUARDING RULE — judge THIS message on its own content: the safeguarding rule protects a disclosure of harm; it does NOT grant a respondent blanket immunity for every later message. A disclosure earlier in the conversation does not make a subsequent message genuine. Judge the message in RESPONDENT'S ANSWER by what IT contains. So when THIS message is purely hostility, an insult, or profanity aimed at the interviewer or survey — carrying NO new disclosure, distress *about a situation*, or substantive answer (e.g. "go fuck yourself", "piss off", "you're useless") — it is ABUSIVE and you must return {"serious": false}, EVEN IF an earlier turn contained a genuine disclosure. The RECENT CONVERSATION is context for reading THIS message, not a reason to keep it. (A message that pairs venting WITH content or a fresh disclosure — "I'm still being bullied and I'm furious" — stays genuine: keep it.)

Mark "serious": true (KEEP — this is the default for almost everything), including:
- Brief, blunt, terse, or low-effort answers ("very unlikely", "dunno", "not really", "nothing", "no idea").
- Cynical, negative, critical, vague, opinionated, or emotional answers ("people are dishonest", "management doesn't listen", "it's all broken", "I don't trust them").
- Answers that only loosely, indirectly, or tangentially relate to the question — if there is ANY plausible way the answer responds to what was asked, KEEP it. Real respondents answer obliquely, reframe the question, or raise an adjacent concern; that is still genuine signal to learn from.
- Honest refusals, "prefer not to say", or "I'd rather not answer".
- Plausible answers that are imperfectly phrased, partial, or off-the-cuff.

Mark "serious": false (disregard) ONLY when the answer is clearly one of:
- ABUSIVE: hostile, threatening, or offensive language directed at the survey or people.
- PREPOSTEROUS / IMPOSSIBLE: an obvious joke or troll, or a value that cannot be real for the question (e.g. a tenure of "543 years", an age of 9000, "I am a banana").
- NONSENSICAL: gibberish, random characters, keyboard-mashing, or spam with no real words or meaning.

Do NOT disregard an answer merely for being short, negative, cynical, unhelpful, off-topic-sounding, or not what you hoped for. Brevity, negativity, and tangents are NOT failures. When in any doubt at all, choose "serious": true.

For "serious": false, "reason" is ONE short, polite, respondent-safe sentence explaining why it doesn't read as genuine (no quoting back abusive content). For "serious": true, "reason" may be empty.`;

/** Build the judge prompt for one answer. */
export function buildSeriousnessJudgePrompt(input: SeriousnessJudgeInput): {
  system: string;
  user: string;
} {
  const lines: string[] = [];
  lines.push(`QUESTION ASKED:\n${input.questionPrompt || '(no specific question)'}`);
  lines.push(`\nRESPONDENT'S ANSWER:\n${input.userMessage}`);
  if (input.extractedValue !== undefined) {
    lines.push(`\nVALUE PARSED FROM THE ANSWER:\n${JSON.stringify(input.extractedValue)}`);
  }
  if (input.recentMessages && input.recentMessages.length > 0) {
    // A little context helps judge off-topic vs on-topic; cap to the last few lines.
    const recent = input.recentMessages.slice(-4).join('\n');
    lines.push(`\nRECENT CONVERSATION (for context):\n${recent}`);
  }
  lines.push('\nIs this answer a genuine attempt? Respond with the JSON verdict only.');
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}
