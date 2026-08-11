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
      raisedMilestones: [25, 50, 75],
    });
  });

  it('never re-announces a threshold already in the ledger', () => {
    expect(resolveMilestoneCrossing(ON, 0.5, [25, 50], 4)).toEqual({
      announce: null,
      raisedMilestones: undefined,
    });
  });

  it('announces only the genuinely new threshold when the ledger is partially filled', () => {
    expect(resolveMilestoneCrossing(ON, 0.5, [25], 4)).toEqual({
      announce: 50,
      raisedMilestones: [25, 50],
    });
  });

  it('stays silent when coverage falls back below an already-raised threshold', () => {
    // Coverage is NOT monotonic — a contradiction resolution can invalidate an answer. The ledger
    // is what stops 50% re-firing when the respondent climbs back up.
    expect(resolveMilestoneCrossing(ON, 0.3, [25, 50], 4)).toEqual({
      announce: null,
      raisedMilestones: undefined,
    });
  });

  it('returns nothing at all when the feature is off, however high coverage is', () => {
    expect(resolveMilestoneCrossing({ ...ON, milestoneBannerEnabled: false }, 1, [], 4)).toEqual({
      announce: null,
      raisedMilestones: undefined,
    });
  });

  it('handles an empty threshold list (banners on, nothing configured to fire)', () => {
    expect(resolveMilestoneCrossing({ ...ON, milestoneBannerThresholds: [] }, 1, [], 4)).toEqual({
      announce: null,
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
      raisedMilestones: undefined,
    });
    const withNew = { milestoneBannerEnabled: true, milestoneBannerThresholds: [25, 60, 90] };
    expect(resolveMilestoneCrossing(withNew, 0.92, [25, 90], 4)).toEqual({
      announce: null, // 60 is behind the 90 already announced — bank it silently
      raisedMilestones: [25, 60, 90],
    });
  });

  it('announces nothing for a version with no questions', () => {
    // Both coverage helpers report 1 for an empty question set, which would otherwise fire the top
    // milestone on the opening turn of a pure data-slot version.
    expect(resolveMilestoneCrossing(ON, 1, [], 0)).toEqual({
      announce: null,
      raisedMilestones: undefined,
    });
  });

  it('keeps the returned ledger sorted and free of duplicates', () => {
    // An unsorted stored ledger (hand-edited row) must not produce a jumbled or duplicated list.
    expect(resolveMilestoneCrossing(ON, 0.9, [50, 25], 4)).toEqual({
      announce: 90,
      raisedMilestones: [25, 50, 75, 90],
    });
  });

  it('tolerates an unsorted threshold list from config', () => {
    const unsorted = { milestoneBannerEnabled: true, milestoneBannerThresholds: [75, 25, 50] };
    expect(resolveMilestoneCrossing(unsorted, 0.75, [], 4)).toEqual({
      announce: 75,
      raisedMilestones: [25, 50, 75],
    });
  });
});

describe('milestoneMessage', () => {
  it('phrases the threshold as respondent-facing progress copy', () => {
    expect(milestoneMessage(50)).toBe("You're 50% of the way through.");
  });
});
