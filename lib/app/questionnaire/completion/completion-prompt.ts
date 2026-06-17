/**
 * Prompt builder for the completion-offer composer (F4.5).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with no
 * provider/SDK import. The capability hands these to whatever provider the completion
 * agent resolves to. As with the extractor and detector prompts, the stable contract
 * this module owns is the *structure* — a system rules message plus a user message
 * summarising what's covered, what (optionally) remains, and the recent conversation —
 * not the exact wording, which is free to evolve.
 *
 * The eligibility decision is already made deterministically (`assessCompletion`); the
 * model is only asked to *phrase* the offer, never to judge whether to offer. So the
 * prompt presents the offer as a settled fact and asks for a warm, natural message.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { joinSections, section, titledBlock } from '@/lib/app/questionnaire/prompt/format';

/** One question, identified for the recap (no respondent values — PII stays out). */
export interface CompletionPromptSlot {
  key: string;
  prompt: string;
}

/** Everything the offer composer needs to phrase the offer. */
export interface CompletionOfferPromptInput {
  /** Weighted coverage in [0, 1] at offer time. */
  coverage: number;
  /** Distinct questions answered this session. */
  answeredCount: number;
  /** Whether the per-session cap forced the offer (vs. thresholds being met). */
  capReached: boolean;
  /** The questions that have been answered — recap material (prompts only, no values). */
  coveredSlots: CompletionPromptSlot[];
  /** Optional questions still open the respondent could still answer if they want. */
  remainingSlots: CompletionPromptSlot[];
  /** Recent user messages, oldest → newest, to match tone. */
  recentMessages: string[];
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Build the system rules: phrase a submission offer, don't re-decide eligibility. */
function systemRules(): string {
  return `You are wrapping up a conversational questionnaire. The system has already \
determined the respondent has answered enough to submit — your ONLY job is to phrase a \
warm, natural offer to submit, and recap what was covered.

Return one JSON object with:
- "offerMessage": a short, friendly message offering to submit now and inviting the \
respondent to either confirm or keep going.
- "coveredSummary": one or two sentences recapping what's been covered, in plain language.
- "remainingNote": OPTIONAL — only if some optional questions remain, a brief note that \
they can still add more if they like. Omit it entirely when nothing remains.

Rules:
- Do NOT re-litigate whether they're done — they are. Don't ask new questionnaire questions.
- Be concise and conversational; match the respondent's tone from the recent messages.
- Never invent topics that aren't in the covered list.

Output: respond with ONLY a single JSON object. Do not wrap the JSON in prose or code fences.`;
}

/** Render the covered/remaining question lists compactly for the prompt. */
function slotLines(slots: CompletionPromptSlot[]): string {
  return slots.map((s) => `- ${s.prompt}`).join('\n');
}

/**
 * Build the system + user messages for one offer composition. The user message
 * carries the coverage stats, the covered questions (prompts only — no respondent
 * values, keeping PII out of the recap), any optional remaining questions, and the
 * recent conversation for tone.
 */
export function buildCompletionOfferPrompt(input: CompletionOfferPromptInput): LlmMessage[] {
  const status = input.capReached
    ? `Status: the per-session question cap has been reached, so it's time to wrap up.`
    : `Status: coverage is ${pct(input.coverage)} with ${input.answeredCount} question(s) answered — enough to submit.`;

  const covered =
    input.coveredSlots.length > 0
      ? titledBlock('Questions covered', slotLines(input.coveredSlots))
      : `Questions covered: (none recorded)`;

  // Named XML sections so the status, recap, optional list, and tone transcript are clearly
  // separable. Section text is unchanged; absent parts collapse to nothing.
  const userContent = joinSections(
    section('status', status),
    section('covered', covered),
    input.remainingSlots.length > 0
      ? section(
          'remaining',
          titledBlock('Optional questions still open', slotLines(input.remainingSlots))
        )
      : '',
    input.recentMessages.length > 0
      ? section(
          'transcript',
          titledBlock('Recent conversation (oldest → newest)', input.recentMessages.join('\n'))
        )
      : '',
    section('task', 'Compose the offer to submit now.')
  );

  return [
    { role: 'system', content: section('completion_rules', systemRules()) },
    { role: 'user', content: userContent },
  ];
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix the
 * named fields.
 */
export function buildCompletionOfferRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object with "offerMessage", "coveredSummary", and (optionally) ` +
    `"remainingNote", matching the specified shape exactly.` +
    detail
  );
}
