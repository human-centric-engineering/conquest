/**
 * Deterministic routing rules — pure, DB-free.
 *
 * Evaluated BEFORE the LLM selector. First match wins and the selector is never called, which is
 * both a control affordance (an author who is certain about a case can pin it) and a latency one
 * (the respondent is waiting at the fork; a rule resolves in microseconds where the selector takes
 * seconds).
 *
 * Data-in/data-out over the carry-over fills and the rule list, exhaustively unit-testable by
 * hand — the same posture as `session/cost-cap.ts` and the rest of the session core.
 */

import type { CarryOverFill } from '@/lib/app/questionnaire/experiences/run/types';
import type { RoutingRule } from '@/lib/app/questionnaire/experiences/routing/types';
import { fillText } from '@/lib/app/questionnaire/experiences/carryover/text';

/**
 * The numeric reading of a fill, or null when it has none.
 *
 * Digit-extraction is deliberate: respondents answer "about 500 people" and "£2.5m", and a rule
 * author writing `gt: 100` means the quantity, not the string. Returns null rather than 0 when
 * nothing numeric is present, so `gt: 0` does not silently match every text answer.
 */
function fillNumber(fill: CarryOverFill): number | null {
  if (typeof fill.value === 'number') return Number.isFinite(fill.value) ? fill.value : null;

  const text = fillText(fill);
  if (text.trim() === '') return null;

  // Strip thousands separators and currency/unit noise, then take the first number present.
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whether a fill counts as answered at all. */
function isFilled(fill: CarryOverFill): boolean {
  if (fill.value === null || fill.value === undefined) {
    return (fill.paraphrase ?? '').trim() !== '';
  }
  if (typeof fill.value === 'string') return fill.value.trim() !== '';
  if (Array.isArray(fill.value)) return fill.value.length > 0;
  return true;
}

/** Whether one rule matches the fill for its slot. */
export function ruleMatches(rule: RoutingRule, fill: CarryOverFill | undefined): boolean {
  // A rule about a slot the respondent never filled cannot match — including `exists`, whose whole
  // purpose is to test for presence.
  if (!fill || !isFilled(fill)) return false;

  switch (rule.operator) {
    case 'exists':
      return true;

    case 'equals': {
      if (rule.value === null) return false;
      return fillText(fill).trim().toLowerCase() === rule.value.trim().toLowerCase();
    }

    case 'contains': {
      if (rule.value === null) return false;
      const needle = rule.value.trim().toLowerCase();
      // An empty operand would match everything, which is never what an author meant to write.
      if (needle === '') return false;
      return fillText(fill).toLowerCase().includes(needle);
    }

    case 'gt':
    case 'lt': {
      if (rule.value === null) return false;
      const operand = Number(rule.value);
      if (!Number.isFinite(operand)) return false;
      const actual = fillNumber(fill);
      // A non-numeric answer never satisfies a numeric comparison — it is not "less than"
      // everything, it is simply not comparable.
      if (actual === null) return false;
      return rule.operator === 'gt' ? actual > operand : actual < operand;
    }
  }
}

/**
 * Evaluate the rule list against the carry-over fills, in ordinal order.
 *
 * Returns the `targetStepKey` of the first matching rule, or null when none match (in which case
 * the caller falls through to the LLM selector).
 *
 * `validStepKeys`, when supplied, filters out rules pointing at a step that no longer exists — an
 * author can delete a step a rule still names. A dangling rule is treated as a non-match rather
 * than an error: the run continues to the selector, which is strictly better than failing a
 * respondent's fork over an authoring slip.
 */
export function evaluateRoutingRules(
  rules: readonly RoutingRule[],
  fills: readonly CarryOverFill[],
  validStepKeys?: readonly string[]
): string | null {
  if (rules.length === 0) return null;

  const byKey = new Map(fills.map((f) => [f.key, f]));
  const valid = validStepKeys ? new Set(validStepKeys) : null;

  const ordered = [...rules].sort((a, b) => a.ordinal - b.ordinal);
  for (const rule of ordered) {
    if (valid && !valid.has(rule.targetStepKey)) continue;
    if (ruleMatches(rule, byKey.get(rule.dataSlotKey))) return rule.targetStepKey;
  }
  return null;
}

/**
 * Rules that name a step key which no longer exists.
 *
 * Surfaced in the admin routing editor so an author can see the dangling rule they created by
 * deleting a step — it is silently skipped at run time, and silence is exactly what makes this
 * kind of mistake survive.
 */
export function danglingRules(
  rules: readonly RoutingRule[],
  validStepKeys: readonly string[]
): readonly RoutingRule[] {
  const valid = new Set(validStepKeys);
  return rules.filter((rule) => !valid.has(rule.targetStepKey));
}
