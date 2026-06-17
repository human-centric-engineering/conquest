/**
 * Prompt builder for the contradiction detector (F4.3).
 *
 * Pure and provider-agnostic: returns `LlmMessage[]` (the shared chat shape) with
 * no provider/SDK import. The capability hands these to whatever provider the
 * detector agent resolves to. As with the extractor's prompt, the stable contract
 * this module owns is the *structure* — a system rules message + a user message
 * carrying the answered slots (question + value) to compare — not the exact
 * wording, which is free to evolve.
 *
 * The helpers below (`describeAnsweredSlot`, `choiceOptions`, `likertScale`) are
 * deliberately local copies of the extractor-prompt versions rather than shared
 * imports: the two prompts must be able to evolve independently, and the helpers
 * are tiny.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  CONTRADICTION_SEVERITIES,
  type AnsweredSlotView,
  type ContradictionContext,
  type ContradictionSlotView,
} from '@/lib/app/questionnaire/contradiction/types';

/** Build the system rules. Under `probe` the model is asked for a follow-up
 *  question; under `flag`/`off` it is not (those modes surface passively).
 *  When `withCurrentStatement` is set, the model is also told to weigh the
 *  respondent's latest message against the captured answers (reversal detection). */
function systemRules(mode: ContradictionContext['mode'], withCurrentStatement: boolean): string {
  const probeLine =
    mode === 'probe'
      ? `\n- "suggestedProbe": ONE neutral follow-up question that lets the respondent reconcile the \
conflicting answers. Ask, don't accuse; don't presume which answer is correct.`
      : '';

  const slotKeysLine = withCurrentStatement
    ? `- "slotKeys": the keys of the conflicting questions. Use ONLY keys from the list. When the \
conflict is between the LATEST MESSAGE and a single recorded answer, list that ONE key; when it is \
between two recorded answers, list two or more.`
    : `- "slotKeys": the keys of the conflicting questions (two or more). Use ONLY keys from the list.`;

  const latestMessageRule = withCurrentStatement
    ? `\n- ALSO compare the respondent's LATEST MESSAGE (given below) against each recorded answer. \
When the latest message reverses or is incompatible with a recorded answer — e.g. they now express \
the opposite sentiment to one recorded earlier — report it against that answer's key, even though \
only one recorded answer is involved.`
    : '';

  return `You review a respondent's answers in a conversational questionnaire and report only \
GENUINE logical contradictions — answers (or an answer and the respondent's latest message) that \
cannot both be true.

Compare the answers below against each other. For each real contradiction, output one entry with:
${slotKeysLine}
- "explanation": a short, specific account of why those answers conflict.
- "severity": one of ${CONTRADICTION_SEVERITIES.join(', ')} — how badly the answers are at odds.
- "confidence": 0–1, how sure you are this is a real contradiction.${probeLine}

Rules:
- Report a contradiction ONLY when the answers are genuinely incompatible. Differences in detail, \
emphasis, or wording are NOT contradictions. When in doubt, do not report it.
- Never invent a conflict to have something to say. If the answers are consistent, return an empty \
"contradictions" array.
- Only reference questions in the provided list, and only ones that have an answer.${latestMessageRule}

Output: respond with ONLY a single JSON object: { "contradictions": [ ... ] }. Do not wrap the \
JSON in prose or code fences.`;
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

/** Render one answered slot — question + the value given — as a model-readable line. */
function describeAnsweredSlot(answer: AnsweredSlotView, slot: ContradictionSlotView): string {
  const lines = [
    `- key: ${slot.key}`,
    `  type: ${slot.type}`,
    `  question: ${slot.prompt}`,
    `  answer: ${renderValue(answer.value)}`,
  ];
  if (slot.guidelines) lines.push(`  guidelines: ${slot.guidelines}`);
  const options = choiceOptions(slot.typeConfig);
  if (options.length > 0) lines.push(`  options: ${options.join(', ')}`);
  const scale = likertScale(slot.typeConfig);
  if (scale) lines.push(`  scale: ${scale}`);
  if (typeof answer.confidence === 'number') {
    lines.push(`  answer_confidence: ${answer.confidence}`);
  }
  return lines.join('\n');
}

/**
 * Build the system + user messages for one detection pass. The user message lists
 * every answered slot (question + value) the detector should compare. Answers
 * whose `slotKey` has no matching slot definition are skipped (the caller's
 * context builder normally filters these, but guard here too).
 */
export function buildContradictionDetectionPrompt(ctx: ContradictionContext): LlmMessage[] {
  const slotByKey = new Map(ctx.slots.map((s) => [s.key, s]));

  const answeredLines: string[] = [];
  for (const answer of ctx.answers) {
    const slot = slotByKey.get(answer.slotKey);
    if (slot) answeredLines.push(describeAnsweredSlot(answer, slot));
  }

  const latestMessage = typeof ctx.currentStatement === 'string' ? ctx.currentStatement.trim() : '';
  const hasLatest = latestMessage.length > 0;

  const userContent =
    `Answered questions to check for contradictions:\n${answeredLines.join('\n')}\n\n` +
    (hasLatest
      ? `The respondent's LATEST MESSAGE:\n"${latestMessage}"\n\n` +
        `Report genuine logical contradictions between these answers, AND any answer the latest ` +
        `message reverses or is incompatible with.`
      : `Report only genuine logical contradictions between these answers.`);

  return [
    { role: 'system', content: systemRules(ctx.mode, hasLatest) },
    { role: 'user', content: userContent },
  ];
}

/**
 * Stricter retry message (sent as a `user` turn) when the first response failed
 * schema validation. Deliberately does not echo the malformed output — see
 * `runStructuredCompletion`. Pass the validation `issues` so the model can fix the
 * named fields.
 */
export function buildContradictionDetectionRetryMessage(issuePaths: string[]): string {
  const detail =
    issuePaths.length > 0
      ? ` The previous response was invalid at: ${issuePaths.join('; ')}.`
      : ' The previous response was not valid JSON for the required schema.';
  return (
    `Return ONLY the JSON object { "contradictions": [ ... ] }, matching the specified shape ` +
    `exactly. Each contradiction needs "slotKeys" (two or more), "explanation", "severity", and ` +
    `"confidence" (0–1).` +
    detail
  );
}
