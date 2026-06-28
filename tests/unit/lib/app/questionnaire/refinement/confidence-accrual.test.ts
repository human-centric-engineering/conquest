/**
 * Confidence accrual — the "strengthen on confirmation" rule.
 *
 * Anti-green-bar: asserts the actual numeric trajectory (a tentative score climbs over
 * successive confirmations, converging toward the ceiling without ever dropping), the
 * null-handling on first capture / unscored turns, and that provenance only ever upgrades
 * to `direct` — never downgrades a stronger label.
 *
 * @see lib/app/questionnaire/refinement/confidence-accrual.ts
 */

import { describe, it, expect } from 'vitest';

import {
  accrueConfidence,
  corroboratedProvenance,
  CONFIDENCE_CEILING,
} from '@/lib/app/questionnaire/refinement/confidence-accrual';

describe('accrueConfidence', () => {
  it('takes the incoming score when there is no prior (first scored capture)', () => {
    expect(accrueConfidence(null, 0.4)).toBe(0.4);
    expect(accrueConfidence(undefined, 0.4)).toBe(0.4);
  });

  it('keeps the prior when the confirming turn carries no score (never erases)', () => {
    expect(accrueConfidence(0.62, null)).toBe(0.62);
    expect(accrueConfidence(0.62, undefined)).toBe(0.62);
  });

  it('returns null when neither turn scored the answer', () => {
    expect(accrueConfidence(null, null)).toBeNull();
  });

  it('climbs a step toward the ceiling on each same-value confirmation', () => {
    // step 0.34, ceiling 0.95: 0.45 → +0.34*(0.5)=0.62 → +0.34*(0.33)=0.732 → …
    const a = accrueConfidence(0.45, 0.45);
    expect(a).toBe(0.62);
    const b = accrueConfidence(a, 0.45);
    expect(b).toBe(0.732);
    const c = accrueConfidence(b, 0.45);
    expect(c).toBeGreaterThan(b!);
    expect(c).toBeLessThan(CONFIDENCE_CEILING);
  });

  it('is monotonic and converges toward — but never exceeds — the ceiling', () => {
    let score: number | null = 0.3;
    let prev: number | null = score;
    for (let i = 0; i < 25; i++) {
      score = accrueConfidence(score, 0.3);
      expect(score!).toBeGreaterThanOrEqual(prev!); // never drops
      expect(score!).toBeLessThanOrEqual(CONFIDENCE_CEILING);
      prev = score;
    }
    expect(score!).toBeGreaterThan(0.94); // effectively at the ceiling after many confirmations
  });

  it('never lowers the score when this turn is less confident than the prior', () => {
    // prior 0.9, incoming 0.5 → base 0.9, stepped up toward ceiling, never below 0.9
    const merged = accrueConfidence(0.9, 0.5);
    expect(merged!).toBeGreaterThanOrEqual(0.9);
  });

  it('preserves a score already at or above the ceiling (emphatic direct statement)', () => {
    expect(accrueConfidence(0.98, 0.98)).toBe(0.98);
    expect(accrueConfidence(0.95, 0.6)).toBe(0.95);
  });

  it('jumps up when a later turn states the answer far more confidently', () => {
    // prior inferred 0.45, now direct 0.9 → base 0.9, nudged a touch higher
    const merged = accrueConfidence(0.45, 0.9);
    expect(merged!).toBeGreaterThanOrEqual(0.9);
    expect(merged!).toBeLessThanOrEqual(CONFIDENCE_CEILING);
  });
});

describe('corroboratedProvenance', () => {
  it('upgrades to direct when the respondent now states it outright', () => {
    expect(corroboratedProvenance('inferred', 'direct')).toBe('direct');
    expect(corroboratedProvenance('synthesised', 'direct')).toBe('direct');
  });

  it('keeps the existing label when this turn is not a direct statement', () => {
    expect(corroboratedProvenance('inferred', 'inferred')).toBe('inferred');
    expect(corroboratedProvenance('synthesised', 'inferred')).toBe('synthesised');
  });

  it('never downgrades a direct answer back to inferred', () => {
    expect(corroboratedProvenance('direct', 'inferred')).toBe('direct');
    expect(corroboratedProvenance('direct', 'synthesised')).toBe('direct');
  });
});
