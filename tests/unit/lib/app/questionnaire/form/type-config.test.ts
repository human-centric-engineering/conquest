/**
 * Client-safe typeConfig readers for the raw form surface (P-presentation).
 *
 * These back the form field components, which must never throw on a malformed or
 * absent config. The tests pin: a valid config parses to the typed shape; garbage /
 * absence falls back safely (null for required-config types, defaults for optional);
 * and negative likert bounds (e.g. −2..+2) survive.
 *
 * @see lib/app/questionnaire/form/type-config.ts
 */

import { describe, it, expect } from 'vitest';

import {
  readChoicesConfig,
  readLikertConfig,
  readNumericConfig,
  readBooleanConfig,
} from '@/lib/app/questionnaire/form/type-config';

describe('readChoicesConfig', () => {
  it('parses a valid choice config with labels and allowOther', () => {
    const cfg = readChoicesConfig('single_choice', {
      choices: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
      allowOther: true,
    });
    expect(cfg).toEqual({
      choices: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
      allowOther: true,
    });
  });

  it('defaults allowOther to false when absent', () => {
    const cfg = readChoicesConfig('multi_choice', {
      choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(cfg?.allowOther).toBe(false);
  });

  it('returns null for an unreadable config (so the caller shows no options)', () => {
    expect(readChoicesConfig('single_choice', null)).toBeNull();
    expect(readChoicesConfig('single_choice', { choices: 'nope' })).toBeNull();
    // A single choice fails the schema's `.min(2)` rule → unreadable.
    expect(
      readChoicesConfig('single_choice', { choices: [{ value: 'a', label: 'A' }] })
    ).toBeNull();
  });
});

describe('readLikertConfig', () => {
  it('parses per-point labels and derives the endpoint labels from them', () => {
    expect(readLikertConfig({ min: 1, max: 3, labels: ['Low', 'Mid', 'High'] })).toEqual({
      min: 1,
      max: 3,
      labels: ['Low', 'Mid', 'High'],
      minLabel: 'Low',
      maxLabel: 'High',
    });
  });

  it('reads a legacy endpoint-label config with no per-point labels', () => {
    expect(readLikertConfig({ min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' })).toEqual({
      min: 1,
      max: 5,
      labels: null,
      minLabel: 'Low',
      maxLabel: 'High',
    });
  });

  it('keeps negative bounds (e.g. −2 to +2) and nulls absent labels', () => {
    expect(readLikertConfig({ min: -2, max: 2 })).toEqual({
      min: -2,
      max: 2,
      labels: null,
      minLabel: null,
      maxLabel: null,
    });
  });

  it('keeps the bounds but ignores a wrong-length or blank labels array (treated as unlabelled)', () => {
    // A malformed labels array must not cost the caller the valid bounds.
    expect(readLikertConfig({ min: 1, max: 5, labels: ['a', 'b'] })).toEqual({
      min: 1,
      max: 5,
      labels: null,
      minLabel: null,
      maxLabel: null,
    });
    expect(readLikertConfig({ min: 1, max: 3, labels: ['Low', '', 'High'] })?.labels).toBeNull();
  });

  it('returns null for an unreadable config', () => {
    expect(readLikertConfig(null)).toBeNull();
    // max must be > min — an inverted scale is rejected.
    expect(readLikertConfig({ min: 5, max: 1 })).toBeNull();
  });
});

describe('readNumericConfig', () => {
  it('parses bounds, step, and unit', () => {
    expect(readNumericConfig({ min: 0, max: 100, step: 5, unit: '%' })).toEqual({
      min: 0,
      max: 100,
      step: 5,
      unit: '%',
    });
  });

  it('returns all-null for an absent or unreadable config (unconstrained input)', () => {
    expect(readNumericConfig(undefined)).toEqual({ min: null, max: null, step: null, unit: null });
    expect(readNumericConfig(null)).toEqual({ min: null, max: null, step: null, unit: null });
    expect(readNumericConfig({ min: 10, max: 1 })).toEqual({
      min: null,
      max: null,
      step: null,
      unit: null,
    });
  });
});

describe('readBooleanConfig', () => {
  it('parses custom labels', () => {
    expect(readBooleanConfig({ trueLabel: 'Agree', falseLabel: 'Disagree' })).toEqual({
      trueLabel: 'Agree',
      falseLabel: 'Disagree',
    });
  });

  it('defaults to Yes/No when absent', () => {
    expect(readBooleanConfig(undefined)).toEqual({ trueLabel: 'Yes', falseLabel: 'No' });
    expect(readBooleanConfig(null)).toEqual({ trueLabel: 'Yes', falseLabel: 'No' });
  });
});
