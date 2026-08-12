import { describe, it, expect } from 'vitest';

import {
  evaluateScopeRules,
  scopeRuleMatches,
  type ScopeFill,
} from '@/lib/app/questionnaire/scope/rules';
import type { ScopeRule } from '@/lib/app/questionnaire/scope/types';

function fill(over: Partial<ScopeFill> = {}): ScopeFill {
  return { key: 'headcount', value: null, paraphrase: 'about 500 people', ...over };
}

function rule(over: Partial<ScopeRule> = {}): ScopeRule {
  return {
    id: 'r1',
    dataSlotKey: 'headcount',
    operator: 'exists',
    value: null,
    action: 'include',
    topicKey: 'enterprise',
    ordinal: 0,
    ...over,
  };
}

describe('scopeRuleMatches — presence', () => {
  it('never matches a slot the respondent did not fill', () => {
    expect(scopeRuleMatches(rule(), undefined)).toBe(false);
  });

  it('never matches an empty fill — including `exists`, whose whole point is presence', () => {
    expect(scopeRuleMatches(rule(), fill({ value: null, paraphrase: '   ' }))).toBe(false);
    expect(scopeRuleMatches(rule(), fill({ value: '' }))).toBe(false);
    expect(scopeRuleMatches(rule(), fill({ value: [], paraphrase: null }))).toBe(false);
  });

  it('matches `exists` on any real answer', () => {
    expect(scopeRuleMatches(rule(), fill())).toBe(true);
    expect(scopeRuleMatches(rule(), fill({ value: 0, paraphrase: null }))).toBe(true);
    expect(scopeRuleMatches(rule(), fill({ value: false, paraphrase: null }))).toBe(true);
  });
});

describe('scopeRuleMatches — equals', () => {
  it('compares case- and whitespace-insensitively', () => {
    const r = rule({ operator: 'equals', value: '  Healthcare ' });
    expect(scopeRuleMatches(r, fill({ value: 'healthcare' }))).toBe(true);
  });

  it('does not match a partial string', () => {
    const r = rule({ operator: 'equals', value: 'health' });
    expect(scopeRuleMatches(r, fill({ value: 'healthcare' }))).toBe(false);
  });

  it('never matches when the author supplied no operand', () => {
    expect(scopeRuleMatches(rule({ operator: 'equals', value: null }), fill())).toBe(false);
  });
});

describe('scopeRuleMatches — contains', () => {
  it('matches a substring of the paraphrase', () => {
    const r = rule({ operator: 'contains', value: 'reseller' });
    expect(scopeRuleMatches(r, fill({ paraphrase: 'We sell through resellers in EMEA' }))).toBe(
      true
    );
  });

  it('never matches on an empty operand — that would match everything', () => {
    expect(scopeRuleMatches(rule({ operator: 'contains', value: '   ' }), fill())).toBe(false);
  });

  it('reads an array value as its joined elements', () => {
    const r = rule({ operator: 'contains', value: 'partners' });
    expect(scopeRuleMatches(r, fill({ value: ['direct', 'partners'], paraphrase: null }))).toBe(
      true
    );
  });
});

describe('scopeRuleMatches — numeric comparison', () => {
  it('extracts the quantity from a natural answer', () => {
    // Respondents say "about 500 people"; an author writing gt: 100 means the quantity.
    const r = rule({ operator: 'gt', value: '100' });
    expect(scopeRuleMatches(r, fill({ paraphrase: 'about 500 people' }))).toBe(true);
  });

  it('handles thousands separators and currency noise', () => {
    const r = rule({ operator: 'gt', value: '1000' });
    expect(scopeRuleMatches(r, fill({ paraphrase: '£2,500,000 ARR' }))).toBe(true);
  });

  it('prefers a real numeric value over the paraphrase', () => {
    const r = rule({ operator: 'lt', value: '10' });
    expect(scopeRuleMatches(r, fill({ value: 5, paraphrase: 'about 900' }))).toBe(true);
  });

  it('never matches when the answer contains no number at all', () => {
    // A non-numeric answer is not "less than everything" — it is simply not comparable.
    const r = rule({ operator: 'lt', value: '100' });
    expect(scopeRuleMatches(r, fill({ paraphrase: 'quite a lot, honestly' }))).toBe(false);
  });

  it('never matches on a non-numeric operand', () => {
    expect(scopeRuleMatches(rule({ operator: 'gt', value: 'lots' }), fill())).toBe(false);
  });
});

describe('evaluateScopeRules', () => {
  const fills = [
    fill({ key: 'headcount', paraphrase: '600 staff' }),
    fill({ key: 'channel', value: 'resellers', paraphrase: null }),
  ];

  it('returns nothing when there are no rules', () => {
    const out = evaluateScopeRules([], fills);
    expect(out.include.size).toBe(0);
    expect(out.exclude.size).toBe(0);
  });

  it('applies EVERY match, not just the first', () => {
    // Include and exclude are independent assertions about different topics; stopping at the first
    // would silently drop the rest, so an author who wrote three rules would see one work.
    const out = evaluateScopeRules(
      [
        rule({ id: 'a', dataSlotKey: 'headcount', operator: 'gt', value: '500', topicKey: 'ent' }),
        rule({
          id: 'b',
          dataSlotKey: 'channel',
          operator: 'contains',
          value: 'reseller',
          topicKey: 'channels',
          ordinal: 1,
        }),
      ],
      fills
    );

    expect([...out.include].sort()).toEqual(['channels', 'ent']);
  });

  it('lets exclude beat a lower-ordinal include on the same topic', () => {
    const out = evaluateScopeRules(
      [
        rule({ id: 'a', operator: 'exists', action: 'include', topicKey: 'ai', ordinal: 0 }),
        rule({ id: 'b', operator: 'exists', action: 'exclude', topicKey: 'ai', ordinal: 1 }),
      ],
      fills
    );

    expect(out.include.has('ai')).toBe(false);
    expect(out.exclude.has('ai')).toBe(true);
  });

  it('lets exclude beat a HIGHER-ordinal include too — a line drawn stays drawn', () => {
    const out = evaluateScopeRules(
      [
        rule({ id: 'a', operator: 'exists', action: 'exclude', topicKey: 'ai', ordinal: 0 }),
        rule({ id: 'b', operator: 'exists', action: 'include', topicKey: 'ai', ordinal: 1 }),
      ],
      fills
    );

    expect(out.include.has('ai')).toBe(false);
    expect(out.exclude.has('ai')).toBe(true);
  });

  it('skips a rule naming a topic that no longer exists', () => {
    const out = evaluateScopeRules([rule({ topicKey: 'deleted' })], fills, ['ent', 'channels']);
    expect(out.include.size).toBe(0);
  });

  it('records a human-readable reason per topic', () => {
    const out = evaluateScopeRules(
      [rule({ dataSlotKey: 'headcount', operator: 'gt', value: '500', topicKey: 'ent' })],
      fills
    );

    expect(out.reasonByTopic.get('ent')).toContain('headcount');
    expect(out.reasonByTopic.get('ent')).toContain('500');
  });

  it('evaluates in ordinal order regardless of array order', () => {
    const out = evaluateScopeRules(
      [
        rule({ id: 'late', operator: 'exists', action: 'include', topicKey: 'x', ordinal: 5 }),
        rule({ id: 'early', operator: 'exists', action: 'exclude', topicKey: 'x', ordinal: 1 }),
      ],
      fills
    );

    expect(out.exclude.has('x')).toBe(true);
  });
});
