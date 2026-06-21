/**
 * Prompts for AI-authoring the respondent intro "about this questionnaire" section (F12.2).
 *
 * Two turns, one contract: both `generate` (from a brief) and `refine` (rewrite supplied text per an
 * instruction) ask for a single JSON object `{ "background": "<markdown>" }`. The copy is
 * respondent-facing, so the system prompt fixes the voice (warm, plain, British English), the shape
 * (a few short paragraphs / light markdown), and the guard rails (never invent facts; no headings
 * that duplicate the "About this questionnaire" title the splash already renders).
 *
 * Pure + provider-agnostic: returns `LlmMessage[]`, no I/O. The capability runs them through
 * `runStructuredCompletion`.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';

const SHARED_RULES = `You write the short "about this questionnaire" introduction a respondent reads on the splash screen before they begin.

Rules:
- Warm, clear, and respectful — speak to the respondent ("you"), not about them.
- Plain British English. No jargon, no hype.
- A few short paragraphs (aim for 2–4). Light markdown only (bold, simple bullet lists) — do NOT add a top-level heading; the screen already shows an "About this questionnaire" title above your text.
- Cover what's relevant from the input: who is running this, its purpose, and how the results will be used. Keep it honest.
- Never invent specific facts (company names, figures, policies) that aren't given to you. If the input is thin, stay general rather than fabricating detail.
- Keep it under ${INTRO_BACKGROUND_MAX_LENGTH} characters.

Return ONLY a JSON object of the form {"background": "<markdown string>"} with no other text.`;

/** Generate a fresh intro background from a plain-English brief. */
export function buildGenerateIntroBackgroundPrompt(brief: string): LlmMessage[] {
  return [
    { role: 'system', content: SHARED_RULES },
    {
      role: 'user',
      content: `Write the intro background from this brief:\n\n${brief}`,
    },
  ];
}

/** Rewrite the supplied intro background per a natural-language instruction. */
export function buildRefineIntroBackgroundPrompt(
  currentText: string,
  instruction: string
): LlmMessage[] {
  return [
    { role: 'system', content: SHARED_RULES },
    {
      role: 'user',
      content: `Here is the current intro background:\n\n"""\n${currentText}\n"""\n\nRewrite it according to this instruction, keeping everything still accurate and in the same voice:\n\n${instruction}`,
    },
  ];
}

/** Retry nudge (user-message content) when the model's first reply wasn't valid `{ background }` JSON. */
export function buildIntroBackgroundRetryMessage(): string {
  return 'That was not valid. Reply with ONLY a JSON object of the form {"background": "<markdown string>"} and nothing else.';
}
