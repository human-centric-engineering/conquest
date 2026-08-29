/**
 * resolveDisplayedProgress — the progress ratchet (F17.33).
 *
 * Conditional Topics widens an interview after it has started (the plan landing at the end of the
 * opening, a respondent amendment), which grows the coverage denominator. This is the rule that
 * turns the resulting drop into a stall: the drawn figure never goes below the highest one already
 * shown, and — the load-bearing exception — the floor may never itself claim completion.
 *
 * @see lib/app/questionnaire/completion/progress.ts
 */

import { describe, it, expect } from 'vitest';

import {
  resolveDisplayedProgress,
  progressPctFromCoverage,
  PROGRESS_RATCHET_CEILING,
} from '@/lib/app/questionnaire/completion/progress';

describe('progressPctFromCoverage', () => {
  it('rounds coverage to a whole percent', () => {
    expect(progressPctFromCoverage(0.333)).toBe(33);
    expect(progressPctFromCoverage(0.335)).toBe(34);
  });

  it('clamps before rounding, so an out-of-range figure cannot round its way past a threshold', () => {
    expect(progressPctFromCoverage(1.4)).toBe(100);
    expect(progressPctFromCoverage(-0.2)).toBe(0);
  });
});

describe('resolveDisplayedProgress', () => {
  it('shows the computed figure and banks it when nothing has been shown yet', () => {
    expect(resolveDisplayedProgress(29, 0)).toEqual({ pct: 29, progressFloorPct: 29 });
  });

  it('holds the floor when the denominator grows — the whole point', () => {
    // The plan lands: 5 of 17 (29%) becomes 5 of 38 (13%). The respondent must not watch the bar
    // fall in the same beat as the interviewer announcing what it will now cover.
    expect(resolveDisplayedProgress(13, 29)).toEqual({ pct: 29, progressFloorPct: undefined });
  });

  it('releases as soon as the true figure passes the floor', () => {
    expect(resolveDisplayedProgress(31, 29)).toEqual({ pct: 31, progressFloorPct: 31 });
  });

  it('banks nothing when the figure is unchanged', () => {
    expect(resolveDisplayedProgress(29, 29)).toEqual({ pct: 29, progressFloorPct: undefined });
  });

  it('never lets the FLOOR claim completion', () => {
    // Reached by completing a narrow interview and then having it widened by a late amendment.
    // "100% completed" beside an interviewer still asking questions is a worse lie than any drop.
    expect(resolveDisplayedProgress(80, 100)).toEqual({
      pct: PROGRESS_RATCHET_CEILING,
      progressFloorPct: undefined,
    });
    expect(PROGRESS_RATCHET_CEILING).toBe(99);
  });

  it('shows 100 when the interview is genuinely complete, whatever the floor', () => {
    expect(resolveDisplayedProgress(100, 0)).toEqual({ pct: 100, progressFloorPct: 100 });
    expect(resolveDisplayedProgress(100, 99)).toEqual({ pct: 100, progressFloorPct: 100 });
  });

  it('is monotonic across a widening sequence', () => {
    // Drive a whole session through it: climb, widen, stall, recover.
    const computed = [0, 12, 29, 13, 16, 24, 31, 100];
    let floor = 0;
    const shown: number[] = [];
    for (const pct of computed) {
      const out = resolveDisplayedProgress(pct, floor);
      floor = out.progressFloorPct ?? floor;
      shown.push(out.pct);
    }

    expect(shown).toEqual([0, 12, 29, 29, 29, 29, 31, 100]);
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
  });

  it('degrades a junk floor to zero rather than throwing — a bad column must not take down a turn', () => {
    expect(resolveDisplayedProgress(40, Number.NaN)).toEqual({ pct: 40, progressFloorPct: 40 });
    expect(resolveDisplayedProgress(40, -10)).toEqual({ pct: 40, progressFloorPct: 40 });
    expect(resolveDisplayedProgress(40, 1000)).toEqual({
      pct: PROGRESS_RATCHET_CEILING,
      progressFloorPct: undefined,
    });
  });
});
