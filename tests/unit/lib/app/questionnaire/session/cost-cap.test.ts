/**
 * Unit tests for the F6.3 cost-cap classifier — pure, exhaustive over the boundaries.
 *
 * `classifyCostCap(spent, cap)` grades a session's spend against its budget:
 *   - null / non-positive cap → uncapped (`none`)
 *   - spent ≥ cap → `hard`
 *   - spent ≥ 90% of cap (but < cap) → `soft`
 *   - else → `none`
 * The exact threshold is the contract the route enforces against, so the at/just-below
 * boundaries are pinned rather than spot-checked.
 */

import { describe, expect, it } from 'vitest';

import { classifyCostCap, SOFT_CAP_RATIO } from '@/lib/app/questionnaire/session/cost-cap';

describe('classifyCostCap', () => {
  it('SOFT_CAP_RATIO is 0.9', () => {
    expect(SOFT_CAP_RATIO).toBe(0.9);
  });

  it('treats a null cap as uncapped (always none)', () => {
    expect(classifyCostCap(0, null)).toBe('none');
    expect(classifyCostCap(1_000, null)).toBe('none');
  });

  it('treats a zero or negative cap as uncapped (never an instant hard-stop)', () => {
    expect(classifyCostCap(0, 0)).toBe('none');
    expect(classifyCostCap(5, 0)).toBe('none');
    expect(classifyCostCap(5, -1)).toBe('none');
  });

  it('is none well below the soft threshold', () => {
    expect(classifyCostCap(0, 10)).toBe('none');
    expect(classifyCostCap(8.99, 10)).toBe('none');
  });

  it('is soft exactly at 90% of the cap', () => {
    expect(classifyCostCap(9, 10)).toBe('soft');
  });

  it('is soft just below the cap', () => {
    expect(classifyCostCap(9.999, 10)).toBe('soft');
  });

  it('is hard exactly at the cap', () => {
    expect(classifyCostCap(10, 10)).toBe('hard');
  });

  it('is hard above the cap', () => {
    expect(classifyCostCap(12.5, 10)).toBe('hard');
  });

  it('grades fractional (cent-scale) budgets at the same boundaries', () => {
    expect(classifyCostCap(0.44, 0.5)).toBe('none'); // 88%
    expect(classifyCostCap(0.45, 0.5)).toBe('soft'); // 90%
    expect(classifyCostCap(0.5, 0.5)).toBe('hard'); // 100%
  });
});
