/**
 * Unit test: confidence band mapping (F7.2).
 *
 * Pins the four-band boundaries (0.85 / 0.65 / 0.45 edges), the null/NaN → unscored path, and
 * that each band yields its classes + respondent-facing label. The fourth band ("tentative")
 * tracks the finer extraction rubric so a terse/vague answer (~0.45–0.65) reads distinctly from a
 * confident one and a tangential inference (< 0.45).
 */

import { describe, it, expect } from 'vitest';

import {
  confidenceBand,
  confidenceBandClasses,
  confidenceBandLabel,
  confidencePercent,
} from '@/lib/app/questionnaire/panel/confidence';

describe('confidenceBand', () => {
  it('classifies high at and above 0.85', () => {
    expect(confidenceBand(0.85)).toBe('high');
    expect(confidenceBand(1)).toBe('high');
  });

  it('classifies moderate in [0.65, 0.85)', () => {
    expect(confidenceBand(0.65)).toBe('moderate');
    expect(confidenceBand(0.8499)).toBe('moderate');
  });

  it('classifies tentative in [0.45, 0.65)', () => {
    expect(confidenceBand(0.45)).toBe('tentative');
    expect(confidenceBand(0.6499)).toBe('tentative');
  });

  it('classifies low below 0.45', () => {
    expect(confidenceBand(0.44)).toBe('low');
    expect(confidenceBand(0)).toBe('low');
  });

  it('treats null and NaN as unscored', () => {
    expect(confidenceBand(null)).toBe('unscored');
    expect(confidenceBand(Number.NaN)).toBe('unscored');
  });
});

describe('confidencePercent', () => {
  it('rounds a 0–1 confidence to a percentage string', () => {
    expect(confidencePercent(0.3)).toBe('30%');
    expect(confidencePercent(0.955)).toBe('96%');
    expect(confidencePercent(1)).toBe('100%');
    expect(confidencePercent(0)).toBe('0%');
  });

  it('clamps out-of-range values', () => {
    expect(confidencePercent(1.4)).toBe('100%');
    expect(confidencePercent(-0.2)).toBe('0%');
  });

  it('returns null when unscored', () => {
    expect(confidencePercent(null)).toBeNull();
    expect(confidencePercent(Number.NaN)).toBeNull();
  });
});

describe('confidenceBandClasses', () => {
  it('returns a distinct tint per band and muted for unscored', () => {
    expect(confidenceBandClasses('high')).toContain('emerald');
    expect(confidenceBandClasses('moderate')).toContain('amber');
    expect(confidenceBandClasses('tentative')).toContain('orange');
    expect(confidenceBandClasses('low')).toContain('red');
    expect(confidenceBandClasses('unscored')).toContain('muted');
  });
});

describe('confidenceBandLabel', () => {
  it('gives a semantic label per band', () => {
    expect(confidenceBandLabel('high')).toBe('Confident');
    expect(confidenceBandLabel('moderate')).toBe('Fairly sure');
    expect(confidenceBandLabel('tentative')).toBe('Tentative');
    expect(confidenceBandLabel('low')).toBe('Unsure');
    expect(confidenceBandLabel('unscored')).toBe('Captured');
  });
});
