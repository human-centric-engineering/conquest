/**
 * resolveMilestoneCrossing — the pure completeness-milestone decision (F-progress).
 *
 * The two turn pipelines (`runTurn`, `runDataSlotTurn`) both delegate here, so this is where the
 * rules are actually pinned: one banner per turn (the highest crossed), every crossed threshold
 * banked, and a ledger that survives coverage moving back down.
 *
 * @see lib/app/questionnaire/completion/milestones.ts
 */

import { describe, it, expect } from 'vitest';

import {
  resolveMilestoneCrossing,
  milestoneMessage,
} from '@/lib/app/questionnaire/completion/milestones';

const ON = { milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 50, 75, 90] };

describe('resolveMilestoneCrossing', () => {
  it('announces nothing below the lowest threshold', () => {
    expect(resolveMilestoneCrossing(ON, 0.1, [], 4)).toEqual({
      announce: null,
      coveragePct: 10,
      raisedMilestones: undefined,
    });
  });

  it('announces a threshold exactly on the boundary', () => {
    // 0.25 → 25%, which IS the threshold: crossing is `>=`, not `>`.
    expect(resolveMilestoneCrossing(ON, 0.25, [], 4)).toMatchObject({ announce: 25 });
  });

  it('announces only the highest crossed threshold, banking the ones jumped over', () => {
    // 0% → 75% in one turn (a rich answer filling several slots).
    expect(resolveMilestoneCrossing(ON, 0.75, [], 4)).toEqual({
      announce: 75,
      coveragePct: 75,
      raisedMilestones: [25, 50, 75],
    });
  });

  it('never re-announces a threshold already in the ledger', () => {
    expect(resolveMilestoneCrossing(ON, 0.5, [25, 50], 4)).toEqual({
      announce: null,
      coveragePct: 50,
      raisedMilestones: undefined,
    });
  });

  it('announces only the genuinely new threshold when the ledger is partially filled', () => {
    expect(resolveMilestoneCrossing(ON, 0.5, [25], 4)).toEqual({
      announce: 50,
      coveragePct: 50,
      raisedMilestones: [25, 50],
    });
  });

  it('stays silent when coverage falls back below an already-raised threshold', () => {
    // Coverage is NOT monotonic — a contradiction resolution can invalidate an answer. The ledger
    // is what stops 50% re-firing when the respondent climbs back up.
    expect(resolveMilestoneCrossing(ON, 0.3, [25, 50], 4)).toEqual({
      announce: null,
      coveragePct: 30,
      raisedMilestones: undefined,
    });
  });

  it('returns nothing at all when the feature is off, however high coverage is', () => {
    expect(resolveMilestoneCrossing({ ...ON, milestoneBannerEnabled: false }, 1, [], 4)).toEqual({
      announce: null,
      coveragePct: 100,
      raisedMilestones: undefined,
    });
  });

  it('handles an empty threshold list (banners on, nothing configured to fire)', () => {
    expect(resolveMilestoneCrossing({ ...ON, milestoneBannerThresholds: [] }, 1, [], 4)).toEqual({
      announce: null,
      coveragePct: 100,
      raisedMilestones: undefined,
    });
  });

  it('clamps out-of-range coverage rather than letting it reach a threshold it should not', () => {
    expect(resolveMilestoneCrossing(ON, -0.5, [], 4)).toMatchObject({ announce: null });
    // Above 1 clamps to 100%, which legitimately clears every threshold.
    expect(resolveMilestoneCrossing(ON, 1.8, [], 4)).toMatchObject({ announce: 90 });
  });

  it('banks but does NOT announce a threshold added below one already announced', () => {
    // Thresholds are editable on a LAUNCHED version (and the fork copies them), so an admin can
    // add a 60 while a respondent already sits at 92% with 90 banked. Announcing "You're 60% of
    // the way through." beside a progress bar reading 92% would read as broken.
    // Baseline: nothing new crossed at all → the column is left untouched.
    expect(resolveMilestoneCrossing(ON, 0.92, [25, 50, 75, 90], 4)).toEqual({
      announce: null,
      coveragePct: 92,
      raisedMilestones: undefined,
    });
    const withNew = { milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 60, 90] };
    expect(resolveMilestoneCrossing(withNew, 0.92, [25, 90], 4)).toEqual({
      announce: null, // 60 is behind the 90 already announced — bank it silently
      coveragePct: 92,
      raisedMilestones: [25, 60, 90],
    });
  });

  it('announces nothing for a version with no questions', () => {
    // Both coverage helpers report 1 for an empty question set, which would otherwise fire the top
    // milestone on the opening turn of a pure data-slot version.
    expect(resolveMilestoneCrossing(ON, 1, [], 0)).toEqual({
      announce: null,
      coveragePct: 100,
      raisedMilestones: undefined,
    });
  });

  it('keeps the returned ledger sorted and free of duplicates', () => {
    // An unsorted stored ledger (hand-edited row) must not produce a jumbled or duplicated list.
    expect(resolveMilestoneCrossing(ON, 0.9, [50, 25], 4)).toEqual({
      announce: 90,
      coveragePct: 90,
      raisedMilestones: [25, 50, 75, 90],
    });
  });

  it('tolerates an unsorted threshold list from config', () => {
    const unsorted = { milestoneBannerEnabled: true, milestoneBannerThresholds: [75, 25, 50] };
    expect(resolveMilestoneCrossing(unsorted, 0.75, [], 4)).toEqual({
      announce: 75,
      coveragePct: 75,
      raisedMilestones: [25, 50, 75],
    });
  });

  it('reports the respondent’s real coverage, not the threshold that fired', () => {
    // The threshold decides WHETHER to speak; coverage decides what is TRUE. They come apart
    // whenever the admin's thresholds are sparse, or a single rich answer clears several at once.
    // A lone threshold of 40 with the respondent at 92% used to announce "You're 40% of the way
    // through." beside a progress bar reading 92%.
    const sparse = { milestoneBannerEnabled: true, milestoneBannerThresholds: [40] };
    const out = resolveMilestoneCrossing(sparse, 0.92, [], 10);

    expect(out.announce).toBe(40); // the crossing is still keyed on the threshold…
    expect(out.coveragePct).toBe(92); // …but the copy states the truth
    expect(milestoneMessage(out.coveragePct)).toBe("You're 92% of the way through.");
    expect(out.raisedMilestones).toEqual([40]);
  });

  it('reports 100%, not the top threshold, on a fully covered session', () => {
    // The default thresholds top out at 90, so a completed session used to be told it was 90% done.
    const out = resolveMilestoneCrossing(ON, 1, [], 4);
    expect(out.announce).toBe(90);
    expect(milestoneMessage(out.coveragePct)).toBe("You're 100% of the way through.");
  });

  it('carries coverage on every silent path too, so a caller can always log it', () => {
    expect(resolveMilestoneCrossing(ON, 0.37, [25], 4).coveragePct).toBe(37);
    expect(
      resolveMilestoneCrossing({ ...ON, milestoneBannerEnabled: false }, 0.37, [], 4).coveragePct
    ).toBe(37);
    // Clamped, not raw — the same clamp the announcing path uses.
    expect(resolveMilestoneCrossing(ON, 1.8, [], 4).coveragePct).toBe(100);
    expect(resolveMilestoneCrossing(ON, -0.5, [], 4).coveragePct).toBe(0);
  });
});

describe('milestoneMessage', () => {
  it('phrases the respondent’s coverage as progress copy', () => {
    expect(milestoneMessage(50)).toBe("You're 50% of the way through.");
    expect(milestoneMessage(92)).toBe("You're 92% of the way through.");
  });
});
