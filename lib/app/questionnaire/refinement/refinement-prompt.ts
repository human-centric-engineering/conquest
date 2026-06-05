/**
 * Prompt builder for the answer refiner (F4.4).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with no
 * provider/SDK import. The capability hands these to whatever provider the refiner
 * agent resolves to. As with the extractor's and detector's prompts, the stable
 * contract this module owns is the *structure* — a system rules message + a user
 * message carrying the existing answers and the new context — not the exact wording,
 * which is free to evolve.
 *
 * The render helpers below are deliberately local copies of the sibling-prompt
 * versions rather than shared imports: the prompts must evolve independently, and the
 * helpers are tiny.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  REFINEMENT_ACTIONS,
  REFINEMENT_SOURCES,
  type ExistingAnswerView,
  type RefinementContext,
  type RefinementSlotView,
} from '@/lib/app/questionnaire/refinement/types';

/** Build the system rules: how to choose refine / overwrite / leave, and the
 *  per-decision output contract. */
function systemRules(): string {
  return `You maintain a respondent's already-captured answers in a conversational \
questionnaire. Given new context (a clarifying message and/or a contradiction to \
reconcile), decide for each affected answer whether to update it.

For each answer that the new context bears on, output one decision with:
- "slotKey": the key of the answer's question. Use ONLY keys from the list below.
- "action": one of ${REFINEMENT_ACTIONS.join(', ')}.
    - "refine": the answer genuinely changes in light of later context (the \
respondent reconsidered, or reconciled a contradiction). Use this when the value \
evolves — it is recorded as a refinement.
    - "overwrite": the earlier value was simply a mistake (a typo, the wrong option, \
a mis-capture) and should be corrected. The value was never what they meant.
    - "leave": the new context does not change this answer. Output nothing to change.
- "newValue": the corrected/updated value, in the SAME shape the question expects \
(a string, number, boolean, or array of option values). Required for refine and \
overwrite; omit for leave.
- "rationale": a short, specific reason for the decision.
- "source": one of ${REFINEMENT_SOURCES.join(', ')} — what prompted it (use \
"contradiction" when reconciling a flagged conflict, "clarification" when the \
respondent volunteered a correction, "correction" for a plain mistake fix).
- "confidence": 0–1, how sure you are.

Rules:
- Only change an answer when the new context genuinely warrants it. If nothing \
should change, return an empty "refinements" array.
- Never invent a change. Do not "improve" an answer that is already correct.
- Only reference questions in the provided list, and only ones that already have an \
answer.

Output: respond with ONLY a single JSON object: { "refinements": [ ... ] }. Do not \
wrap the JSON in prose or code fences.`;
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

/** Render a single scalar value without tripping on object default-stringification. */
function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Render the respondent's value compactly for the prompt. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (Array.isArray(value)) return value.map(renderScalar).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return renderScalar(value);
}

/** Render one existing answer — question + current value + provenance — for review. */
function describeExistingAnswer(answer: ExistingAnswerView, slot: RefinementSlotView): string {
  const lines = [
    `- key: ${slot.key}`,
    `  type: ${slot.type}`,
    `  question: ${slot.prompt}`,
    `  current_answer: ${renderValue(answer.value)}`,
    `  current_provenance: ${answer.provenance}`,
  ];
  if (slot.guidelines) lines.push(`  guidelines: ${slot.guidelines}`);
  const options = choiceOptions(slot.typeConfig);
  if (options.length > 0) lines.push(`  options: ${options.join(', ')}`);
  const scale = likertScale(slot.typeConfig);
  if (scale) lines.push(`  scale: ${scale}`);
  return lines.join('\n');
}

/**
 * Build the system + user messages for one refinement pass. The user message lists
 * every existing answer (question + current value) the refiner may update, then the
 * new context: the triggering contradiction (when present) and/or the respondent's
 * new message. Answers whose `slotKey` has no matching slot definition are skipped
 * (the caller's context builder normally filters these, but guard here too).
 */
export function buildRefinementPrompt(ctx: RefinementContext): LlmMessage[] {
  const slotByKey = new Map(ctx.slots.map((s) => [s.key, s]));

  const answerLines: string[] = [];
  for (const answer of ctx.existingAnswers) {
    const slot = slotByKey.get(answer.slotKey);
    if (slot) answerLines.push(describeExistingAnswer(answer, slot));
  }

  const contextParts: string[] = [`Existing answers:\n${answerLines.join('\n')}`];

  if (ctx.triggeringContradiction) {
    const { explanation, suggestedProbe } = ctx.triggeringContradiction;
    const probeLine = suggestedProbe
      ? `\nSuggested follow-up that was asked: ${suggestedProbe}`
      : '';
    contextParts.push(
      `A contradiction was flagged between these answers:\n${explanation}${probeLine}`
    );
  }

  if (ctx.recentMessages && ctx.recentMessages.length > 0) {
    contextParts.push(`Recent conversation:\n${ctx.recentMessages.join('\n')}`);
  }

  if (ctx.userMessage) {
    contextParts.push(`The respondent's new message:\n${ctx.userMessage}`);
  }

  contextParts.push(`Decide which existing answers (if any) the new context warrants updating.`);

  return [
    { role: 'system', content: systemRules() },
    { role: 'user', content: contextParts.join('\n\n') },
  ];
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix the
 * named fields.
 */
export function buildRefinementRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object { "refinements": [ ... ] }, matching the specified shape ` +
    `exactly. Each decision needs "slotKey", "action" (refine/overwrite/leave), "rationale", ` +
    `"source", and "confidence" (0–1); refine/overwrite also need "newValue".` +
    detail
  );
}
