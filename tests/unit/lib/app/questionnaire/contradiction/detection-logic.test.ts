import { describe, expect, it } from 'vitest';

import {
  normalizeContradictionFindings,
  shouldRunDetection,
} from '@/lib/app/questionnaire/contradiction/detection-logic';

import {
  answered,
  contradiction,
  ctx,
  slot,
} from '@/tests/unit/lib/app/questionnaire/contradiction/_fixtures';

describe('normalizeContradictionFindings', () => {
  it('keeps a well-formed contradiction between two answered slots', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b'] })],
      context
    );
    expect(dropped).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.slotKeys).toEqual(['a', 'b']);
  });

  it('drops a finding that references an unknown slot key', () => {
    const context = ctx({
      slots: [slot({ key: 'a' }), slot({ key: 'b' })],
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'ghost'] })],
      context
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/unknown slot key/);
  });

  it('drops a finding that references a known but unanswered slot', () => {
    const context = ctx({
      slots: [slot({ key: 'a' }), slot({ key: 'b' })],
      answers: [answered({ slotKey: 'a' })], // b exists but isn't answered
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b'] })],
      context
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/unanswered slot key/);
  });

  it('drops a finding that collapses to fewer than two distinct slots', () => {
    const context = ctx({ answers: [answered({ slotKey: 'a' })] });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'a'] })],
      context
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/fewer than two distinct slots/);
  });

  it('keeps a single-slot finding when a current statement is supplied (reversal)', () => {
    // The latest message is the implicit second party — one stored slot it reverses is enough.
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
      currentStatement: 'actually the opposite is true',
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a'] })],
      context
    );
    expect(dropped).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.slotKeys).toEqual(['a']);
  });

  it('still drops a zero-slot finding even with a current statement', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' })],
      currentStatement: 'the opposite is true',
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: [] })],
      context
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/no slot referenced/);
  });

  it('without a current statement, a single-slot finding is still dropped (≥2 rule holds)', () => {
    const context = ctx({ answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })] });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a'] })],
      context
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/fewer than two distinct slots/);
  });

  it('de-duplicates symmetric pairs, keeping the higher-confidence finding', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [
        contradiction({ slotKeys: ['a', 'b'], confidence: 0.6, explanation: 'low' }),
        contradiction({ slotKeys: ['b', 'a'], confidence: 0.95, explanation: 'high' }),
      ],
      context
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidence).toBe(0.95);
    expect(findings[0]?.explanation).toBe('high');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/duplicate contradiction/);
  });

  it('keeps the first finding on a confidence tie (stable)', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings } = normalizeContradictionFindings(
      [
        contradiction({ slotKeys: ['a', 'b'], confidence: 0.7, explanation: 'first' }),
        contradiction({ slotKeys: ['a', 'b'], confidence: 0.7, explanation: 'second' }),
      ],
      context
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.explanation).toBe('first');
  });

  it('clamps an out-of-vocabulary severity to medium (direct caller bypassing Zod)', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings } = normalizeContradictionFindings(
      // Cast: simulate a caller that skipped schema validation.
      [contradiction({ slotKeys: ['a', 'b'], severity: 'bogus' as unknown as 'high' })],
      context
    );
    expect(findings[0]?.severity).toBe('medium');
  });

  it('strips a suggestedProbe under flag mode', () => {
    const context = ctx({
      mode: 'flag',
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b'], suggestedProbe: 'which is right?' })],
      context
    );
    expect(findings[0]?.suggestedProbe).toBeUndefined();
  });

  it('keeps a suggestedProbe under probe mode', () => {
    const context = ctx({
      mode: 'probe',
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b'], suggestedProbe: 'which is right?' })],
      context
    );
    expect(findings[0]?.suggestedProbe).toBe('which is right?');
  });

  it('downgrade-keeps a probe-mode finding whose probe is missing or blank', () => {
    const context = ctx({
      mode: 'probe',
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })],
    });
    const { findings, dropped } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b'], suggestedProbe: '   ' })],
      context
    );
    expect(dropped).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedProbe).toBeUndefined();
  });

  it('returns empty findings for empty input', () => {
    const context = ctx({ answers: [answered({ slotKey: 'a' })] });
    const { findings, dropped } = normalizeContradictionFindings([], context);
    expect(findings).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it('supports a three-way contradiction across distinct answered slots', () => {
    const context = ctx({
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' }), answered({ slotKey: 'c' })],
    });
    const { findings } = normalizeContradictionFindings(
      [contradiction({ slotKeys: ['a', 'b', 'c'] })],
      context
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.slotKeys).toEqual(['a', 'b', 'c']);
  });
});

describe('shouldRunDetection', () => {
  it('never runs when the mode is off', () => {
    expect(shouldRunDetection('off', 0, 'turn')).toEqual({ run: false, compareWindow: 'all' });
    expect(shouldRunDetection('off', 5, 'completion-sweep')).toEqual({
      run: false,
      compareWindow: 'all',
    });
  });

  it('runs and compares all answers on the completion sweep, ignoring the window', () => {
    expect(shouldRunDetection('flag', 3, 'completion-sweep')).toEqual({
      run: true,
      compareWindow: 'all',
    });
    expect(shouldRunDetection('probe', 0, 'completion-sweep')).toEqual({
      run: true,
      compareWindow: 'all',
    });
  });

  it('runs every turn comparing all answers when the window is zero', () => {
    expect(shouldRunDetection('flag', 0, 'turn')).toEqual({ run: true, compareWindow: 'all' });
  });

  it('runs every turn comparing the last N answers when a window is set', () => {
    expect(shouldRunDetection('probe', 4, 'turn')).toEqual({ run: true, compareWindow: 4 });
  });

  it('runs every turn when the cadence is 1 (or absent)', () => {
    expect(shouldRunDetection('flag', 4, 'turn', { everyNTurns: 1, turnIndex: 3 })).toEqual({
      run: true,
      compareWindow: 4,
    });
  });

  it('runs only on turn-index multiples of N when a cadence > 1 is set', () => {
    // every_n_turns = 2 → run on turns 0, 2, 4; skip 1, 3.
    expect(shouldRunDetection('flag', 4, 'turn', { everyNTurns: 2, turnIndex: 0 }).run).toBe(true);
    expect(shouldRunDetection('flag', 4, 'turn', { everyNTurns: 2, turnIndex: 2 }).run).toBe(true);
    const skipped = shouldRunDetection('flag', 4, 'turn', { everyNTurns: 2, turnIndex: 1 });
    expect(skipped.run).toBe(false);
    // A skipped turn still reports the comparison window it *would* have used.
    expect(skipped.compareWindow).toBe(4);
    expect(shouldRunDetection('flag', 4, 'turn', { everyNTurns: 3, turnIndex: 5 }).run).toBe(false);
  });

  it('ignores the cadence for the completion sweep — the final gate never skips', () => {
    expect(
      shouldRunDetection('flag', 4, 'completion-sweep', { everyNTurns: 5, turnIndex: 1 })
    ).toEqual({ run: true, compareWindow: 'all' });
  });
});
