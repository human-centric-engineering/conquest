/**
 * Question fidelity — the domain primitives (F18.1).
 *
 * The two properties worth defending here are the ones the whole feature rests on:
 *   1. a malformed / out-of-range stored value can never break a live turn — it clamps;
 *   2. the version-level gate genuinely makes the per-question dial inert, so an existing
 *      questionnaire behaves exactly as it did before the feature shipped.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_QUESTION_FIDELITY,
  DEFAULT_QUESTION_FIDELITY_VALUE,
  QUESTION_FIDELITY_LABELS,
  QUESTION_FIDELITY_LEVELS,
  QUESTION_FIDELITY_LEVEL_BY_STOP,
  QUESTION_FIDELITY_STOPS,
  QUESTION_FIDELITY_STOP_BY_LEVEL,
  clampQuestionFidelity,
  narrowQuestionFidelity,
  questionFidelityLevel,
  resolveQuestionFidelity,
} from '@/lib/app/questionnaire/types';

describe('question fidelity — the five-stop grid', () => {
  it('maps every stop to a level and back, with no gaps in either direction', () => {
    // A drifted map would silently mis-file a level, so assert the round-trip both ways rather
    // than eyeballing two literals that are easy to edit out of step.
    for (const stop of QUESTION_FIDELITY_STOPS) {
      const level = QUESTION_FIDELITY_LEVEL_BY_STOP[stop];
      expect(QUESTION_FIDELITY_STOP_BY_LEVEL[level]).toBe(stop);
    }
    for (const level of QUESTION_FIDELITY_LEVELS) {
      expect(QUESTION_FIDELITY_LEVEL_BY_STOP[QUESTION_FIDELITY_STOP_BY_LEVEL[level]]).toBe(level);
    }
    expect(Object.keys(QUESTION_FIDELITY_LABELS).sort()).toEqual(
      [...QUESTION_FIDELITY_LEVELS].sort()
    );
  });

  it('treats the neutral midpoint as `balanced` — the pre-feature behaviour', () => {
    expect(DEFAULT_QUESTION_FIDELITY_VALUE).toBe(0.5);
    expect(questionFidelityLevel(DEFAULT_QUESTION_FIDELITY_VALUE)).toBe('balanced');
  });
});

describe('clampQuestionFidelity', () => {
  it('snaps an off-grid value to the nearest stop', () => {
    expect(clampQuestionFidelity(0.13)).toBe(0.25);
    expect(clampQuestionFidelity(0.6)).toBe(0.5);
    expect(clampQuestionFidelity(0.9)).toBe(1);
  });

  it('clamps out-of-range values into the grid rather than throwing', () => {
    expect(clampQuestionFidelity(-4)).toBe(0);
    expect(clampQuestionFidelity(97)).toBe(1);
  });

  it('falls back to the midpoint for anything that is not a finite number', () => {
    // A live turn must survive a hand-edited row or a bad import; the safe landing is the stop
    // that changes nothing.
    for (const bad of [undefined, null, 'must_ask', NaN, Infinity, {}, []]) {
      expect(clampQuestionFidelity(bad)).toBe(0.5);
    }
  });

  it('produces exact grid values, not floating-point neighbours', () => {
    // 0.30000000000000004 would fail an === lookup in QUESTION_FIDELITY_LEVEL_BY_STOP.
    const snapped = clampQuestionFidelity(0.26);
    expect(QUESTION_FIDELITY_LEVEL_BY_STOP[snapped]).toBe('loose');
  });
});

describe('narrowQuestionFidelity', () => {
  it('defaults an absent or malformed block to the off gate', () => {
    for (const bad of [undefined, null, 'on', 42]) {
      expect(narrowQuestionFidelity(bad)).toEqual(DEFAULT_QUESTION_FIDELITY);
    }
    // `{}` is what the column default writes for a version that never saved settings.
    expect(narrowQuestionFidelity({})).toEqual({ enabled: false, defaultFidelity: 0.5 });
  });

  it('keeps a valid block and clamps its defaultFidelity', () => {
    expect(narrowQuestionFidelity({ enabled: true, defaultFidelity: 0.77 })).toEqual({
      enabled: true,
      defaultFidelity: 0.75,
    });
  });

  it('fills only the missing half of a partially-written block', () => {
    expect(narrowQuestionFidelity({ enabled: true })).toEqual({
      enabled: true,
      defaultFidelity: 0.5,
    });
    expect(narrowQuestionFidelity({ defaultFidelity: 1 })).toEqual({
      enabled: false,
      defaultFidelity: 1,
    });
  });
});

describe('resolveQuestionFidelity — the gate', () => {
  it('reports `balanced` for every stored value while the gate is off', () => {
    // This is the no-op guarantee: an admin may set levels in advance, and nothing changes until
    // they switch the feature on.
    for (const stop of QUESTION_FIDELITY_STOPS) {
      expect(resolveQuestionFidelity(stop, { enabled: false, defaultFidelity: 0.5 })).toBe(
        'balanced'
      );
    }
    expect(resolveQuestionFidelity(1, undefined)).toBe('balanced');
    expect(resolveQuestionFidelity(1, {})).toBe('balanced');
  });

  it('honours the stored value once the gate is on', () => {
    const on = { enabled: true, defaultFidelity: 0.5 } as const;
    expect(resolveQuestionFidelity(0, on)).toBe('free');
    expect(resolveQuestionFidelity(0.25, on)).toBe('loose');
    expect(resolveQuestionFidelity(0.5, on)).toBe('balanced');
    expect(resolveQuestionFidelity(0.75, on)).toBe('close');
    expect(resolveQuestionFidelity(1, on)).toBe('must_ask');
  });

  it('clamps a malformed stored value even with the gate on', () => {
    expect(resolveQuestionFidelity('must_ask', { enabled: true, defaultFidelity: 0.5 })).toBe(
      'balanced'
    );
  });
});
