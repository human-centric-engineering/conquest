import { describe, it, expect } from 'vitest';

import {
  CHAT_TEXT_SCALES,
  CHAT_TEXT_SIZES,
  CHAT_TEXT_SIZE_LABELS,
  DEFAULT_CHAT_TEXT_SCALE,
  DEFAULT_CHAT_TEXT_SCALE_INDEX,
  DEFAULT_CHAT_TEXT_SIZE,
  canStep,
  indexForTextSize,
  labelForIndex,
  normalizeScaleIndex,
  scaleForIndex,
  stepScaleIndex,
  textSizeForIndex,
} from '@/lib/app/questionnaire/chat/text-scale';

/**
 * The respondent chat text-size ladder.
 *
 * Two behaviours carry real risk and are asserted directly rather than through the component:
 * stepping must CLAMP (a caller that runs off the end would land on an out-of-range index, which
 * normalisation treats as unrecognised and resets to Standard — shrinking the text at the moment
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
      // Garbage in storage should step from Standard, not produce another out-of-range index.
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
      [1, 1, 'Standard'],
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
      expect(labelForIndex(raw)).toBe('Standard');
    });
  });

  /**
   * The named rungs — what `config.chatTextSize` stores, and the only reason a questionnaire can
   * choose where the ladder opens.
   *
   * The names exist so an authored value survives a retune of the multipliers: a stored `2` would
   * silently mean a different size after the ladder changed, where a stored `large` still means the
   * large one. That only holds while the names stay index-aligned with the multipliers, so the
   * alignment is asserted rather than assumed.
   */
  describe('named rungs', () => {
    it('has exactly one name per multiplier, in the same order', () => {
      expect(CHAT_TEXT_SIZES.length).toBe(CHAT_TEXT_SCALES.length);
      CHAT_TEXT_SIZES.forEach((size, index) => {
        expect(indexForTextSize(size)).toBe(index);
        expect(textSizeForIndex(index)).toBe(size);
      });
    });

    it('names the historical size as the default, so an unset questionnaire is unchanged', () => {
      expect(DEFAULT_CHAT_TEXT_SIZE).toBe('standard');
      expect(indexForTextSize(DEFAULT_CHAT_TEXT_SIZE)).toBe(DEFAULT_CHAT_TEXT_SCALE_INDEX);
      expect(scaleForIndex(indexForTextSize(DEFAULT_CHAT_TEXT_SIZE))).toBe(1);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['a rung a newer deploy knows', 'enormous'],
      ['a ladder INDEX sent as a string', '2'],
      ['a prototype key', 'constructor'],
    ])('opens at standard for %s rather than failing the render', (_label, raw) => {
      // The column is plain TEXT: a rollback, a seed, or a newer deploy can all put something
      // unrecognised there, and a live respondent has to survive it. Note `'2'` — a caller who
      // confused the name for the index must get a readable conversation, not the large rung.
      expect(indexForTextSize(raw)).toBe(DEFAULT_CHAT_TEXT_SCALE_INDEX);
    });

    it('shares one label source with the respondent stepper, so no surface disagrees', () => {
      // The admin picker reads CHAT_TEXT_SIZE_LABELS; the stepper's screen-reader announcement
      // reads labelForIndex. An admin choosing "Large" and a respondent hearing "Large" have to
      // be the same rung, or the setting is unexplainable to the person who authored it.
      CHAT_TEXT_SIZES.forEach((size, index) => {
        expect(labelForIndex(index)).toBe(CHAT_TEXT_SIZE_LABELS[size]);
      });
    });
  });
});
