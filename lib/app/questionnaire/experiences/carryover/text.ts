/**
 * Rendering a carry-over fill as text — pure, DB-free.
 *
 * A data slot's `value` is any JSON shape: a string, a number, a boolean, an array (multi-choice),
 * or an object (a structured answer). Every consumer that turns one into text — the routing rules,
 * the selector prompt, the handoff briefing, the interviewer's context block — must agree on how,
 * because a mismatch means a rule tests one string while the prompt shows another.
 *
 * The naive `String(value)` renders an object as `[object Object]`. In a prompt that is worse than
 * useless: it silently replaces a real answer with a token that means nothing, and the model has no
 * way to know something was lost. This module is the one place that conversion happens.
 */

import type { CarryOverFill } from '@/lib/app/questionnaire/experiences/run/types';

/**
 * Render any stored slot value as human/model-readable text.
 *
 * Arrays join with commas so a multi-choice answer reads naturally and substring rules work on it.
 * Objects serialise as JSON — verbose, but honest and legible to a model, where `[object Object]`
 * is neither. Null and undefined render empty, which callers treat as "no answer".
 */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value))
    return value
      .map(valueToText)
      .filter((v) => v !== '')
      .join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    // A cycle cannot reach here through the normal build path, but a prompt must never carry a
    // thrown error — an empty answer is a safe reading of an unrenderable one.
    return '';
  }
}

/**
 * The comparable/displayable text of a fill.
 *
 * Prefers the structured `value` over the paraphrase: a rule author writing `equals: "yes"` means
 * the answer, not the interviewer's rendering of it. Falls back to the paraphrase when the slot
 * carries no structured value, so free-text slots stay both testable and displayable.
 */
export function fillText(fill: CarryOverFill): string {
  const rendered = valueToText(fill.value);
  return rendered !== '' ? rendered : (fill.paraphrase ?? '');
}

/**
 * How a fill reads in a PROMPT — the respondent's own words where we have them.
 *
 * The inverse preference of {@link fillText}: a paraphrase ("they coordinate through weekly
 * standups but find them too long") gives a model far more to work with than the raw value
 * ("standups"). Rules want the value; prompts want the prose.
 */
export function fillPromptText(fill: CarryOverFill, maxChars: number): string {
  const text = fill.paraphrase?.trim() || valueToText(fill.value);
  return text.slice(0, maxChars);
}
