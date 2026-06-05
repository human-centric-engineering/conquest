/**
 * Prompt builder for the answer extractor (F4.2).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with
 * no provider/SDK import. The capability hands these to whatever provider the
 * answer-extractor agent resolves to. Authored as a real prompt, but the stable
 * contract this module owns is the *structure* — a system rules message + a user
 * message carrying the active question, the candidate slots, the transcript, and
 * the respondent's message — not the exact wording, which is free to evolve.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { EXTRACTOR_EMITTED_PROVENANCES } from '@/lib/app/questionnaire/types';
import type {
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

const SYSTEM_RULES = `You extract structured answers from a respondent's message in a conversational \
questionnaire. The respondent is replying to the ACTIVE question, but a single message often \
answers more than one question — capture every answer you can justify.

For each answer, output one entry with:
- "slotKey": the key of the question it answers. Use ONLY a key from the provided candidate list.
- "value": the answer, typed for that question's type:
    free_text → a string; single_choice → one choice "value"; multi_choice → an array of choice \
"value"s; likert → an integer on the given scale; numeric → a number; date → an ISO-8601 date \
(YYYY-MM-DD); boolean → true/false.
  For choice questions, return the choice's "value" (not its label). Do not invent options.
- "confidence": 0–1, how sure you are of this value.
- "provenance": one of ${EXTRACTOR_EMITTED_PROVENANCES.join(', ')}:
    "direct" — the value is stated in the message; include the exact "sourceQuote".
    "inferred" — the value follows by single-step reasoning from the message but isn't stated.
    "synthesised" — the value combines several turns / the wider conversation; no single span.
- "rationale": a short reason for the value.
- "sourceQuote": the span of the respondent's message the value came from. REQUIRED for "direct".

Rules:
- Only extract answers the message actually supports. If the message answers nothing (a question, \
small talk, "I don't know"), return an empty "answers" array — do not guess.
- Never answer a question that is not in the candidate list, and never re-answer with a value the \
message doesn't support.
- Prefer the respondent's own words; do not normalise away meaning.

Output: respond with ONLY a single JSON object: { "answers": [ ... ] }. Do not wrap the JSON in \
prose or code fences.`;

/** Render one candidate slot as a compact, model-readable line. */
function describeSlot(slot: ExtractionSlotView): string {
  const lines = [`- key: ${slot.key}`, `  type: ${slot.type}`, `  prompt: ${slot.prompt}`];
  if (slot.required) lines.push('  required: true');
  if (slot.guidelines) lines.push(`  guidelines: ${slot.guidelines}`);
  const options = choiceOptions(slot.typeConfig);
  if (options.length > 0) lines.push(`  options: ${options.join(', ')}`);
  const scale = likertScale(slot.typeConfig);
  if (scale) lines.push(`  scale: ${scale}`);
  return lines.join('\n');
}

/** Pull `value (label)` option strings from a choice slot's config, if any. */
function choiceOptions(typeConfig: unknown): string[] {
  if (typeConfig === null || typeof typeConfig !== 'object') return [];
  const choices = (typeConfig as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices
    .filter(
      (c): c is { value: string; label?: string } =>
        typeof c === 'object' && c !== null && typeof (c as { value?: unknown }).value === 'string'
    )
    .map((c) => (typeof c.label === 'string' ? `${c.value} (${c.label})` : c.value));
}

/** Render a likert slot's bounds as `min–max`, if present. */
function likertScale(typeConfig: unknown): string | null {
  if (typeConfig === null || typeof typeConfig !== 'object') return null;
  const { min, max } = typeConfig as { min?: unknown; max?: unknown };
  return typeof min === 'number' && typeof max === 'number' ? `${min}–${max}` : null;
}

/**
 * Build the system + user messages for one extraction turn. The system message
 * is the fixed rule set; the user message carries the active question, the
 * candidate slots (with their types/options), any recent transcript, and the
 * respondent's current message.
 */
export function buildAnswerExtractionPrompt(ctx: ExtractionContext): LlmMessage[] {
  const transcript =
    ctx.recentMessages && ctx.recentMessages.length > 0
      ? `Recent conversation (oldest first):\n${ctx.recentMessages.map((m) => `  • ${m}`).join('\n')}\n\n`
      : '';

  const candidates = ctx.candidateSlots.map(describeSlot).join('\n');

  const userContent =
    `Active question key: ${ctx.activeQuestionKey}\n\n` +
    `Candidate questions (extract answers only for these):\n${candidates}\n\n` +
    transcript +
    `--- RESPONDENT MESSAGE ---\n${ctx.userMessage}\n--- END RESPONDENT MESSAGE ---`;

  return [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: userContent },
  ];
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix
 * the named fields.
 */
export function buildAnswerExtractionRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object { "answers": [ ... ] }, matching the specified shape exactly. ` +
    `Each answer needs "slotKey", "value", "confidence" (0–1), "provenance", and "rationale".` +
    detail
  );
}
