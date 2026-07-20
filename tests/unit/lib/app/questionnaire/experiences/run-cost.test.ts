import { describe, it, expect } from 'vitest';

import {
  classifyRunCostCap,
  effectiveLegBudget,
  mustConcludeForBudget,
  remainingRunBudget,
} from '@/lib/app/questionnaire/experiences/run/cost';
import { SOFT_CAP_RATIO } from '@/lib/app/questionnaire/session/cost-cap';

/**
 * The run-level budget exists because `AppQuestionnaireConfig.costBudgetUsd` is PER SESSION, so a
 * two-leg journey would otherwise silently get twice the intended spend. These tests pin the
 * arithmetic that closes that gap — including the interaction between the two caps, which is where
 * an off-by-one would be expensive and invisible.
 */
describe('classifyRunCostCap', () => {
  it('treats a null or non-positive budget as uncapped', () => {
    expect(classifyRunCostCap(999, null)).toBe('none');
    expect(classifyRunCostCap(999, 0)).toBe('none');
    expect(classifyRunCostCap(999, -1)).toBe('none');
  });

  it('grades below, at the soft threshold, and at the cap', () => {
    expect(classifyRunCostCap(0.5, 2)).toBe('none');
    expect(classifyRunCostCap(SOFT_CAP_RATIO * 2, 2)).toBe('soft');
    expect(classifyRunCostCap(2, 2)).toBe('hard');
    expect(classifyRunCostCap(5, 2)).toBe('hard');
  });

  it('agrees with the session-level classifier it delegates to', () => {
    // One tested implementation is how "soft" and "hard" keep meaning the same thing at both
    // levels; a re-derived ratio here would be free to drift.
    expect(classifyRunCostCap(1.79, 2)).toBe('none');
    expect(classifyRunCostCap(1.8, 2)).toBe('soft');
  });
});

describe('remainingRunBudget', () => {
  it('returns null for an uncapped run', () => {
    expect(remainingRunBudget(5, null)).toBeNull();
    expect(remainingRunBudget(5, 0)).toBeNull();
  });

  it('returns what is left', () => {
    expect(remainingRunBudget(0.75, 2)).toBeCloseTo(1.25);
  });

  it('floors at zero rather than going negative', () => {
    // A negative remainder flowing into `classifyCostCap` would read as a non-positive cap — i.e.
    // UNCAPPED — so an overspent run would silently gain unlimited budget. Zero is what makes the
    // next grade read `hard`.
    expect(remainingRunBudget(5, 2)).toBe(0);
    expect(classifyRunCostCap(0, remainingRunBudget(5, 2))).toBe('none');
    expect(classifyRunCostCap(0.01, 0.0001)).toBe('hard');
  });
});

describe('effectiveLegBudget', () => {
  it('is null only when both caps are absent', () => {
    expect(effectiveLegBudget(null, 0, null)).toBeNull();
  });

  it('uses the session cap when the run is uncapped', () => {
    expect(effectiveLegBudget(1.5, 10, null)).toBe(1.5);
  });

  it("uses the run's remainder when the session is uncapped", () => {
    expect(effectiveLegBudget(null, 0.5, 2)).toBeCloseTo(1.5);
    expect(effectiveLegBudget(0, 0.5, 2)).toBeCloseTo(1.5);
  });

  it('takes the TIGHTER of the two when both apply', () => {
    // The whole point: a generous per-session cap must not let a run exceed its own ceiling.
    expect(effectiveLegBudget(5, 1.5, 2)).toBeCloseTo(0.5);
    expect(effectiveLegBudget(0.25, 1.5, 2)).toBeCloseTo(0.25);
  });

  it('reports zero for a leg on an already-exhausted run', () => {
    expect(effectiveLegBudget(5, 3, 2)).toBe(0);
  });
});

describe('mustConcludeForBudget', () => {
  it('is the handoff gate: true only at the hard cap', () => {
    expect(mustConcludeForBudget(1.5, 2)).toBe(false);
    expect(mustConcludeForBudget(1.85, 2)).toBe(false); // soft — nudge, not a stop
    expect(mustConcludeForBudget(2, 2)).toBe(true);
    expect(mustConcludeForBudget(2.01, 2)).toBe(true);
  });

  it('never forces a conclude on an uncapped run', () => {
    expect(mustConcludeForBudget(1_000, null)).toBe(false);
  });
});
