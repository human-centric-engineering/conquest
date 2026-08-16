/**
 * The opening's follow-up counter (G03 / F17.17).
 *
 * Pure arithmetic over the turn record. The one thing worth stating in a test is what a probe IS:
 * the second and every later turn on the same opening slot, and nothing else.
 */

import { describe, expect, it } from 'vitest';

import {
  countOpeningProbes,
  governsSlot,
  probesRemaining,
  type OpeningProbeBudget,
} from '@/lib/app/questionnaire/scope/probe';

const opening = new Set(['d1', 'd2', 'd3']);

describe('countOpeningProbes', () => {
  it('counts nothing when every opening slot was asked once', () => {
    expect(countOpeningProbes(['d1', 'd2', 'd3'], opening)).toBe(0);
  });

  it('counts the second and every later turn on the same slot', () => {
    expect(countOpeningProbes(['d1', 'd1'], opening)).toBe(1);
    expect(countOpeningProbes(['d1', 'd1', 'd1'], opening)).toBe(2);
    expect(countOpeningProbes(['d1', 'd1', 'd2', 'd2'], opening)).toBe(2);
  });

  it('counts a return to a slot the interview had moved on from', () => {
    // Not only consecutive re-asks: coming back to d1 after d2 is still a second question about d1,
    // and it costs the respondent exactly as much.
    expect(countOpeningProbes(['d1', 'd2', 'd1'], opening)).toBe(1);
  });

  it('ignores turns that targeted nothing, or something outside the opening', () => {
    // Offer/completion turns carry no data-slot id; core-topic slots are not the opening's to ration.
    expect(countOpeningProbes(['d1', null, undefined, 'core_slot', 'd1'], opening)).toBe(1);
  });

  it('is empty for a session that has taken no turns', () => {
    expect(countOpeningProbes([], opening)).toBe(0);
  });
});

describe('probesRemaining', () => {
  const budget = (spent: number, allowance: number): OpeningProbeBudget => ({
    slotIds: ['d1'],
    spent,
    allowance,
  });

  it('reports what is left', () => {
    expect(probesRemaining(budget(0, 1))).toBe(1);
    expect(probesRemaining(budget(1, 1))).toBe(0);
  });

  it('never goes negative when more was spent than allowed', () => {
    // Reachable in one direction only — an author lowering the allowance mid-run — and a negative
    // remainder would flow straight into an effective cap below one, i.e. a slot that can never be
    // asked at all.
    expect(probesRemaining(budget(3, 1))).toBe(0);
  });
});

describe('governsSlot', () => {
  const budget: OpeningProbeBudget = { slotIds: ['d1', 'd2'], spent: 0, allowance: 1 };

  it('governs only the slots the opening names', () => {
    expect(governsSlot(budget, 'd1')).toBe(true);
    expect(governsSlot(budget, 'd9')).toBe(false);
  });

  it('governs nothing when there is no budget at all', () => {
    expect(governsSlot(undefined, 'd1')).toBe(false);
  });
});
