/**
 * Unit: the analytics round-scope query fragment (`roundSessionFilter`) + scope resolution.
 *
 * This is the single translation point that keeps every analytics view scoped identically — so
 * one cohort's round is never blended with another's.
 */

import { describe, it, expect } from 'vitest';

import {
  resolveAnalyticsScope,
  roundSessionFilter,
} from '@/lib/app/questionnaire/analytics/query-schema';

describe('roundSessionFilter', () => {
  it('adds no constraint when round scope is absent (all sessions)', () => {
    expect(roundSessionFilter(undefined)).toEqual({});
  });

  it('matches only non-round (open-ended) sessions for the "none" sentinel', () => {
    expect(roundSessionFilter('none')).toEqual({ roundId: null });
  });

  it('matches exactly one round for a round id (strict isolation)', () => {
    expect(roundSessionFilter('round_abc')).toEqual({ roundId: 'round_abc' });
  });
});

describe('resolveAnalyticsScope', () => {
  it('threads roundId from the validated query onto the scope, alongside the full scope shape', () => {
    const scope = resolveAnalyticsScope('v1', { roundId: 'round_abc', tagIds: 'a,b' });
    expect(scope.roundId).toBe('round_abc');
    expect(scope.versionId).toBe('v1');
    // The other resolved fields must still be derived (date window + parsed tags).
    expect(scope.tagIds).toEqual(['a', 'b']);
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
    expect(scope.from.getTime()).toBeLessThan(scope.to.getTime());
  });

  it('leaves roundId undefined when omitted, with an empty tag filter', () => {
    const scope = resolveAnalyticsScope('v1', {});
    expect(scope.roundId).toBeUndefined();
    expect(scope.tagIds).toEqual([]);
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
  });
});
