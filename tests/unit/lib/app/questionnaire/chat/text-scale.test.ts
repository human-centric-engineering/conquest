import { describe, it, expect } from 'vitest';

import {
  CHAT_TEXT_SCALES,
  DEFAULT_CHAT_TEXT_SCALE,
  DEFAULT_CHAT_TEXT_SCALE_INDEX,
  canStep,
  labelForIndex,
  normalizeScaleIndex,
  scaleForIndex,
  stepScaleIndex,
} from '@/lib/app/questionnaire/chat/text-scale';

/**
 * The respondent chat text-size ladder.
 *
 * Two behaviours carry real risk and are asserted directly rather than through the component:
 * stepping must CLAMP (a caller that runs off the end would land on an out-of-range index, which
 * normalisation treats as unrecognised and resets to Default — shrinking the text at the moment
 * someone pressed "larger"), and normalisation must absorb whatever localStorage actually holds,
 * because a NaN reaching the `calc()` drops the transcript's font-size entirely.
 */
describe('chat text scale ladder', () => {
  it('keeps 1 as the default so an untouched session renders at the historical size', () => {
    expect(DEFAULT_CHAT_TEXT_SCALE).toBe(1);
    expect(CHAT_TEXT_SCALES[DEFAULT_CHAT_TEXT_SCALE_INDEX]).toBe(1);
  });

  it('is ordered smallest to largest', () => {
    const sorted = [...CHAT_TEXT_SCALES].sort((a, b) => a - b);
    expect([...CHAT_TEXT_SCALES]).toEqual(sorted);
  });

  describe('normalizeScaleIndex', () => {
    it('passes through every valid index', () => {
      CHAT_TEXT_SCALES.forEach((_, i) => expect(normalizeScaleIndex(i)).toBe(i));
    });

    it.each([
      ['above the ladder', CHAT_TEXT_SCALES.length],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to the default for a %s value', (_label, raw) => {
      expect(normalizeScaleIndex(raw)).toBe(DEFAULT_CHAT_TEXT_SCALE_INDEX);
    });

    it.each([
      ['a stringified number from a hand-edited store', '2'],
      ['null', null],
      ['undefined', undefined],
      ['an object', { index: 2 }],
    ])('falls back to the default for %s', (_label, raw) => {
      expect(normalizeScaleIndex(raw)).toBe(DEFAULT_CHAT_TEXT_SCALE_INDEX);
    });
  });

  describe('stepScaleIndex', () => {
    it('moves one notch at a time in each direction', () => {
      expect(stepScaleIndex(1, 'up')).toBe(2);
      expect(stepScaleIndex(1, 'down')).toBe(0);
    });

    it('clamps at the largest step instead of wrapping to the smallest', () => {
      const top = CHAT_TEXT_SCALES.length - 1;
      expect(stepScaleIndex(top, 'up')).toBe(top);
      // Repeated presses at the ceiling must hold, never cycle round.
      expect(stepScaleIndex(stepScaleIndex(top, 'up'), 'up')).toBe(top);
    });

    it('clamps at the smallest step instead of going negative', () => {
      expect(stepScaleIndex(0, 'down')).toBe(0);
      expect(stepScaleIndex(stepScaleIndex(0, 'down'), 'down')).toBe(0);
    });

    it('normalises a corrupt starting index before stepping', () => {
      // Garbage in storage should step from Default, not produce another out-of-range index.
      expect(stepScaleIndex('nonsense', 'up')).toBe(DEFAULT_CHAT_TEXT_SCALE_INDEX + 1);
    });

    it('walks the whole ladder and back without leaving range', () => {
      let index = 0;
      for (let i = 0; i < CHAT_TEXT_SCALES.length * 2; i += 1) {
        index = stepScaleIndex(index, 'up');
        expect(index).toBeLessThan(CHAT_TEXT_SCALES.length);
      }
      expect(index).toBe(CHAT_TEXT_SCALES.length - 1);

      for (let i = 0; i < CHAT_TEXT_SCALES.length * 2; i += 1) {
        index = stepScaleIndex(index, 'down');
        expect(index).toBeGreaterThanOrEqual(0);
      }
      expect(index).toBe(0);
    });
  });

  describe('canStep', () => {
    it('reports the ends of the ladder so the buttons can disable', () => {
      const top = CHAT_TEXT_SCALES.length - 1;
      expect(canStep(0, 'down')).toBe(false);
      expect(canStep(0, 'up')).toBe(true);
      expect(canStep(top, 'up')).toBe(false);
      expect(canStep(top, 'down')).toBe(true);
    });

    it('agrees with stepScaleIndex at every position', () => {
      CHAT_TEXT_SCALES.forEach((_, i) => {
        expect(canStep(i, 'up')).toBe(stepScaleIndex(i, 'up') !== i);
        expect(canStep(i, 'down')).toBe(stepScaleIndex(i, 'down') !== i);
      });
    });
  });

  describe('scaleForIndex / labelForIndex', () => {
    // Pinned to literals, not derived from CHAT_TEXT_SCALES: deriving the expectation from the same
    // array the implementation reads would pass even if the whole ladder were replaced. These are the
    // multipliers the stylesheet's calc() is built around, so a change here should break a test.
    it.each([
      [0, 0.9, 'Small'],
      [1, 1, 'Default'],
      [2, 1.15, 'Large'],
      [3, 1.3, 'Largest'],
    ])('maps index %i to multiplier %f and label %s', (index, multiplier, label) => {
      expect(scaleForIndex(index)).toBe(multiplier);
      expect(labelForIndex(index)).toBe(label);
    });

    it.each([
      ['negative', -1],
      ['above the ladder', 99],
      ['NaN', Number.NaN],
      ['a string', 'x'],
      ['null', null],
    ])('resolves a %s index to the default multiplier and label', (_label, raw) => {
      expect(scaleForIndex(raw)).toBe(DEFAULT_CHAT_TEXT_SCALE);
      expect(labelForIndex(raw)).toBe('Default');
    });
  });
});
