import { describe, it, expect } from 'vitest';

import {
  danglingRules,
  evaluateRoutingRules,
  ruleMatches,
} from '@/lib/app/questionnaire/experiences/routing/rules';
import type { RoutingRule } from '@/lib/app/questionnaire/experiences/routing/types';
import type { CarryOverFill } from '@/lib/app/questionnaire/experiences/run/types';

function fill(overrides: Partial<CarryOverFill> = {}): CarryOverFill {
  return {
    key: 'headcount',
    name: 'Headcount',
    theme: null,
    paraphrase: null,
    value: null,
    confidence: null,
    ...overrides,
  };
}

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'r1',
    dataSlotKey: 'headcount',
    operator: 'equals',
    value: null,
    targetStepKey: 'enterprise',
    ordinal: 0,
    ...overrides,
  };
}

/**
 * Rules run BEFORE the LLM selector and short-circuit it entirely, so a false positive silently
 * overrides the author's intended judgement path. Every operator is exercised against the shapes a
 * real fill actually holds — string, number, boolean, array, object, and absent.
 */
describe('ruleMatches', () => {
  describe('exists', () => {
    it('matches any filled slot', () => {
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: 'anything' }))).toBe(true);
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: 0 }))).toBe(true);
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: false }))).toBe(true);
    });

    it('does not match an absent slot', () => {
      expect(ruleMatches(rule({ operator: 'exists' }), undefined)).toBe(false);
    });

    it('does not match an empty-string or empty-array fill', () => {
      // "The respondent answered" must mean they said something, not that a row exists.
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: '' }))).toBe(false);
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: '   ' }))).toBe(false);
      expect(ruleMatches(rule({ operator: 'exists' }), fill({ value: [] }))).toBe(false);
    });

    it('matches a fill carrying only a paraphrase', () => {
      // A free-text slot may have no structured value; the paraphrase IS the answer.
      expect(
        ruleMatches(
          rule({ operator: 'exists' }),
          fill({ value: null, paraphrase: 'they said yes' })
        )
      ).toBe(true);
    });
  });

  describe('equals', () => {
    it('matches case-insensitively and ignores surrounding whitespace', () => {
      const r = rule({ operator: 'equals', value: 'Yes' });
      expect(ruleMatches(r, fill({ value: 'yes' }))).toBe(true);
      expect(ruleMatches(r, fill({ value: '  YES  ' }))).toBe(true);
    });

    it('does not partially match', () => {
      expect(
        ruleMatches(rule({ operator: 'equals', value: 'yes' }), fill({ value: 'yes, but' }))
      ).toBe(false);
    });

    it('compares numbers and booleans by their text', () => {
      expect(ruleMatches(rule({ operator: 'equals', value: '500' }), fill({ value: 500 }))).toBe(
        true
      );
      expect(ruleMatches(rule({ operator: 'equals', value: 'true' }), fill({ value: true }))).toBe(
        true
      );
    });

    it('never matches when the rule has no operand', () => {
      expect(ruleMatches(rule({ operator: 'equals', value: null }), fill({ value: 'x' }))).toBe(
        false
      );
    });
  });

  describe('contains', () => {
    it('matches a substring, case-insensitively', () => {
      expect(
        ruleMatches(
          rule({ operator: 'contains', value: 'coordination' }),
          fill({ value: 'Our Coordination across teams is poor' })
        )
      ).toBe(true);
    });

    it('searches the joined members of a multi-choice answer', () => {
      expect(
        ruleMatches(
          rule({ operator: 'contains', value: 'pricing' }),
          fill({ value: ['onboarding', 'pricing', 'support'] })
        )
      ).toBe(true);
    });

    it('falls back to the paraphrase when there is no structured value', () => {
      expect(
        ruleMatches(
          rule({ operator: 'contains', value: 'budget' }),
          fill({ value: null, paraphrase: 'They are worried about budget next year' })
        )
      ).toBe(true);
    });

    it('never matches on an empty operand', () => {
      // An empty needle would `includes()` into everything — never what an author meant to write.
      expect(ruleMatches(rule({ operator: 'contains', value: '' }), fill({ value: 'x' }))).toBe(
        false
      );
      expect(ruleMatches(rule({ operator: 'contains', value: '   ' }), fill({ value: 'x' }))).toBe(
        false
      );
    });
  });

  describe('gt / lt', () => {
    it('compares a numeric fill', () => {
      expect(ruleMatches(rule({ operator: 'gt', value: '100' }), fill({ value: 500 }))).toBe(true);
      expect(ruleMatches(rule({ operator: 'gt', value: '500' }), fill({ value: 500 }))).toBe(false);
      expect(ruleMatches(rule({ operator: 'lt', value: '100' }), fill({ value: 50 }))).toBe(true);
    });

    it('extracts a number from natural language', () => {
      // Respondents answer "about 500 people", not "500".
      expect(
        ruleMatches(rule({ operator: 'gt', value: '100' }), fill({ value: 'about 500 people' }))
      ).toBe(true);
      expect(
        ruleMatches(
          rule({ operator: 'gt', value: '1000000' }),
          fill({ value: '£2,500,000 turnover' })
        )
      ).toBe(true);
    });

    it('handles negative and decimal values', () => {
      expect(ruleMatches(rule({ operator: 'lt', value: '0' }), fill({ value: '-5% growth' }))).toBe(
        true
      );
      expect(ruleMatches(rule({ operator: 'gt', value: '2.4' }), fill({ value: 2.5 }))).toBe(true);
    });

    it('never matches a non-numeric answer', () => {
      // A text answer is not "less than" everything — it is simply not comparable. Treating it as
      // 0 would make `lt: 100` fire on every free-text response.
      expect(
        ruleMatches(rule({ operator: 'lt', value: '100' }), fill({ value: 'quite a few' }))
      ).toBe(false);
      expect(ruleMatches(rule({ operator: 'gt', value: '0' }), fill({ value: 'lots' }))).toBe(
        false
      );
    });

    it('never matches when the operand is not a number', () => {
      expect(ruleMatches(rule({ operator: 'gt', value: 'many' }), fill({ value: 500 }))).toBe(
        false
      );
    });

    it('does not treat a non-finite stored value as comparable', () => {
      expect(ruleMatches(rule({ operator: 'gt', value: '0' }), fill({ value: Number.NaN }))).toBe(
        false
      );
    });
  });
});

describe('evaluateRoutingRules', () => {
  const fills = [
    fill({ key: 'headcount', value: 500 }),
    fill({ key: 'pain', value: 'coordination across departments' }),
  ];

  it('returns null when there are no rules', () => {
    expect(evaluateRoutingRules([], fills)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(evaluateRoutingRules([rule({ operator: 'equals', value: 'nope' })], fills)).toBeNull();
  });

  it('returns the first match in ORDINAL order, not array order', () => {
    // Ordinal is the author's stated precedence; array order is an accident of the query.
    const rules = [
      rule({ id: 'second', ordinal: 5, operator: 'gt', value: '100', targetStepKey: 'big' }),
      rule({ id: 'first', ordinal: 1, operator: 'gt', value: '10', targetStepKey: 'medium' }),
    ];
    expect(evaluateRoutingRules(rules, fills)).toBe('medium');
  });

  it('skips rules whose target step no longer exists', () => {
    // An author can delete a step a rule still names. Skipping is right — the run falls through to
    // the selector rather than failing a respondent's fork over an authoring slip.
    const rules = [
      rule({ id: 'dangling', ordinal: 0, operator: 'gt', value: '100', targetStepKey: 'deleted' }),
      rule({ id: 'live', ordinal: 1, operator: 'gt', value: '100', targetStepKey: 'enterprise' }),
    ];
    expect(evaluateRoutingRules(rules, fills, ['enterprise'])).toBe('enterprise');
  });

  it('returns null when every matching rule is dangling', () => {
    const rules = [rule({ operator: 'gt', value: '100', targetStepKey: 'deleted' })];
    expect(evaluateRoutingRules(rules, fills, ['enterprise'])).toBeNull();
  });

  it('does not filter by step key when no valid set is supplied', () => {
    const rules = [rule({ operator: 'gt', value: '100', targetStepKey: 'whatever' })];
    expect(evaluateRoutingRules(rules, fills)).toBe('whatever');
  });

  it('ignores rules about slots the respondent never filled', () => {
    const rules = [
      rule({
        id: 'a',
        ordinal: 0,
        dataSlotKey: 'never_asked',
        operator: 'exists',
        targetStepKey: 'x',
      }),
      rule({
        id: 'b',
        ordinal: 1,
        dataSlotKey: 'headcount',
        operator: 'exists',
        targetStepKey: 'y',
      }),
    ];
    expect(evaluateRoutingRules(rules, fills)).toBe('y');
  });

  it('does not mutate the rules array while sorting', () => {
    const rules = [rule({ id: 'a', ordinal: 5 }), rule({ id: 'b', ordinal: 1 })];
    evaluateRoutingRules(rules, fills);
    expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('danglingRules', () => {
  it('reports rules whose target step key is not in the valid set', () => {
    const rules = [
      rule({ id: 'ok', targetStepKey: 'enterprise' }),
      rule({ id: 'gone', targetStepKey: 'deleted' }),
    ];
    expect(danglingRules(rules, ['enterprise']).map((r) => r.id)).toEqual(['gone']);
  });

  it('reports nothing when every target resolves', () => {
    expect(danglingRules([rule({ targetStepKey: 'a' })], ['a', 'b'])).toEqual([]);
  });
});
