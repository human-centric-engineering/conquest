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

const SYSTEM_PROMPT = `You are a strict but fair reviewer deciding whether a single survey answer is a GENUINE attempt to respond, or whether it should be disregarded.

Return ONLY JSON of the form: {"serious": boolean, "reason": string}

Mark "serious": true (a genuine attempt) for:
- Brief, blunt, colloquial, or low-effort answers that still address the question ("very unlikely", "dunno", "not really", "I just don't recommend companies").
- Honest refusals or "prefer not to say".
- Plausible answers even if vague or imperfectly phrased.

Mark "serious": false (disregard) ONLY for answers that are clearly:
- Abusive, hostile, or offensive.
- Absurd or impossible for the question (e.g. a tenure of "543 years", an age of 9000, gibberish, obvious joke/troll answers).
- Completely off-topic or unrelated to what was asked.
- Empty of any real content (random characters, spam).

When unsure, default to "serious": true — only disregard a clear, confident case.
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
