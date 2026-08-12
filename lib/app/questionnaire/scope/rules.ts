/**
 * Adaptive Scope hard rules (P17) — pure, DB-free.
 *
 * Evaluated BEFORE the planner. These exist for the cases an author is *certain* about — "if they
 * sell through partners, always ask about channel conflict", "if they never named an outcome they
 * want AI to move, never score them on AI readiness". Judgement is the planner's job; certainty is
 * this module's.
 *
 * ## Two deliberate differences from the Experience router's rules
 *
 * 1. **Every match applies**, rather than first-match-wins. Include and exclude are independent
 *    assertions about different topics, so stopping at the first would silently drop the rest —
 *    an author who wrote three rules would see one work.
 * 2. **Exclude beats include** on the same topic. A rule saying "never" is an author drawing a
 *    line, and a line drawn should not be crossed by a second rule they forgot they wrote.
 *
 * The operator semantics are otherwise a deliberate port of `experiences/routing/rules.ts`: the
 * same five operators, the same digit-extraction for numeric comparisons, the same "an unfilled
 * slot never matches". Two rule surfaces that behave differently for the same words would be worse
 * than either.
 */

import type { ScopeRule } from '@/lib/app/questionnaire/scope/types';

/** A filled data slot, as the evaluator reads it. Structurally the session's fill projection. */
export interface ScopeFill {
  key: string;
  /** The structured value, when the slot has one. */
  value: unknown;
  /** The natural-language rendering of what the respondent conveyed. */
  paraphrase: string | null;
}

/** The text a rule compares against: the structured value if textual, else the paraphrase. */
function fillText(fill: ScopeFill): string {
  if (typeof fill.value === 'string') return fill.value;
  if (typeof fill.value === 'number' || typeof fill.value === 'boolean') return String(fill.value);
  if (Array.isArray(fill.value)) return fill.value.map((v) => String(v)).join(' ');
  return fill.paraphrase ?? '';
}

/**
 * The numeric reading of a fill, or null when it has none.
 *
 * Digit-extraction is deliberate: respondents answer "about 500 people" and "£2.5m", and an author
 * writing `gt: 100` means the quantity, not the string. Returns null rather than 0 when nothing
 * numeric is present, so `gt: 0` does not silently match every text answer.
 */
function fillNumber(fill: ScopeFill): number | null {
  if (typeof fill.value === 'number') return Number.isFinite(fill.value) ? fill.value : null;

  const text = fillText(fill);
  if (text.trim() === '') return null;

  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whether a fill counts as answered at all. */
function isFilled(fill: ScopeFill): boolean {
  if (fill.value === null || fill.value === undefined) {
    return (fill.paraphrase ?? '').trim() !== '';
  }
  if (typeof fill.value === 'string') return fill.value.trim() !== '';
  if (Array.isArray(fill.value)) return fill.value.length > 0;
  return true;
}

/** Whether one rule matches the fill for its slot. */
export function scopeRuleMatches(rule: ScopeRule, fill: ScopeFill | undefined): boolean {
  const filled = Boolean(fill) && isFilled(fill as ScopeFill);

  // `not_exists` is the ONE operator that matches on absence, so it is evaluated before — and is
  // the deliberate exception to — the unfilled-slot guard below. It exists for vetoes: "never score
  // them on AI readiness when they never named an outcome they want it to move" is a statement
  // about what the respondent did NOT say, and there is no way to write it with the positive
  // operators. Handling it here rather than inside the switch is what keeps the guard's rule
  // ("an unfilled slot never matches") true of everything else — and narrows the operator union,
  // so the switch below stays exhaustive without a `not_exists` case that could never run.
  if (rule.operator === 'not_exists') return !filled;

  // A rule about a slot the respondent never filled cannot match — including `exists`, whose whole
  // purpose is to test for presence.
  if (!fill || !filled) return false;

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

/** What the rule pass decided, before the planner runs. */
export interface RuleOutcome {
  /** Topic keys a rule forces INTO the interview. The planner may not drop these. */
  include: Set<string>;
  /** Topic keys a rule forbids. The planner never sees them as candidates. */
  exclude: Set<string>;
  /** Per topic, the rules that decided it — for the plan's rationale and the audit snapshot. */
  reasonByTopic: Map<string, string>;
}

/**
 * Evaluate every rule against the session's fills.
 *
 * `validTopicKeys`, when supplied, drops rules naming a topic that no longer exists. A dangling
 * rule is a non-match, never an error: an author deleting a topic must not break a live interview,
 * and `validateAdaptiveScope` surfaces the dangling rule on the authoring surface where it can be
 * fixed.
 */
export function evaluateScopeRules(
  rules: readonly ScopeRule[],
  fills: readonly ScopeFill[],
  validTopicKeys?: readonly string[]
): RuleOutcome {
  const outcome: RuleOutcome = {
    include: new Set(),
    exclude: new Set(),
    reasonByTopic: new Map(),
  };
  if (rules.length === 0) return outcome;

  const byKey = new Map(fills.map((f) => [f.key, f]));
  const valid = validTopicKeys ? new Set(validTopicKeys) : null;

  for (const rule of [...rules].sort((a, b) => a.ordinal - b.ordinal)) {
    if (valid && !valid.has(rule.topicKey)) continue;
    if (!scopeRuleMatches(rule, byKey.get(rule.dataSlotKey))) continue;

    const describe = `"${rule.dataSlotKey}" ${rule.operator}${rule.value ? ` "${rule.value}"` : ''}`;
    if (rule.action === 'exclude') {
      outcome.exclude.add(rule.topicKey);
      // Exclude wins: drop any include a lower-ordinal rule added for the same topic.
      outcome.include.delete(rule.topicKey);
      outcome.reasonByTopic.set(rule.topicKey, `A rule excluded this topic because ${describe}.`);
    } else if (!outcome.exclude.has(rule.topicKey)) {
      outcome.include.add(rule.topicKey);
      outcome.reasonByTopic.set(rule.topicKey, `A rule included this topic because ${describe}.`);
    }
  }

  return outcome;
}
