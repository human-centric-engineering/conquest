/**
 * Matrix `typeConfig` validation + readers.
 *
 * @see lib/app/questionnaire/authoring/type-config-schema.ts
 * @see lib/app/questionnaire/form/type-config.ts
 */

import { describe, it, expect } from 'vitest';

import {
  validateTypeConfig,
  defaultTypeConfig,
  isMatrixLabelled,
  typeConfigSchemaFor,
} from '@/lib/app/questionnaire/authoring/type-config-schema';
import { readMatrixConfig } from '@/lib/app/questionnaire/form/type-config';

const endpointScale = { min: 1, max: 5, minLabel: 'Not important', maxLabel: 'Essential' };
const rows = [
  { key: 'fuel_efficiency', label: 'Fuel efficiency' },
  { key: 'reliability', label: 'Reliability' },
];

describe('matrix typeConfig (write validation)', () => {
  it('accepts rows + an endpoint-anchored scale', () => {
    const result = validateTypeConfig('matrix', { rows, scale: endpointScale });
    expect(result.ok).toBe(true);
  });

  it('accepts a fully per-point-labelled scale', () => {
    const result = validateTypeConfig('matrix', {
      rows,
      scale: { min: 1, max: 3, labels: ['Low', 'Mid', 'High'] },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unlabelled scale (no labels, no endpoints)', () => {
    const result = validateTypeConfig('matrix', { rows, scale: { min: 1, max: 5 } });
    expect(result.ok).toBe(false);
  });

  it('rejects zero rows', () => {
    const result = validateTypeConfig('matrix', { rows: [], scale: endpointScale });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate row keys', () => {
    const result = validateTypeConfig('matrix', {
      rows: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'A2' },
      ],
      scale: endpointScale,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing config (matrix is config-required)', () => {
    expect(validateTypeConfig('matrix', undefined).ok).toBe(false);
    expect(validateTypeConfig('matrix', null).ok).toBe(false);
  });
});

describe('isMatrixLabelled', () => {
  it('is true for a launchable grid, false otherwise', () => {
    expect(isMatrixLabelled({ rows, scale: endpointScale })).toBe(true);
    expect(isMatrixLabelled({ rows, scale: { min: 1, max: 5 } })).toBe(false);
    expect(isMatrixLabelled({ rows: [], scale: endpointScale })).toBe(false);
    expect(isMatrixLabelled(null)).toBe(false);
    // A non-matrix config never reads as a labelled matrix.
    expect(isMatrixLabelled({ min: 1, max: 5, labels: ['a', 'b', 'c', 'd', 'e'] })).toBe(false);
  });
});

describe('defaultTypeConfig("matrix")', () => {
  it('produces a config that already passes the write schema', () => {
    const cfg = defaultTypeConfig('matrix');
    expect(validateTypeConfig('matrix', cfg).ok).toBe(true);
  });
});

describe('readMatrixConfig', () => {
  it('parses rows + scale, deriving endpoint labels', () => {
    const cfg = readMatrixConfig({ rows, scale: endpointScale });
    expect(cfg).not.toBeNull();
    expect(cfg?.rows).toHaveLength(2);
    expect(cfg?.min).toBe(1);
    expect(cfg?.max).toBe(5);
    expect(cfg?.minLabel).toBe('Not important');
    expect(cfg?.maxLabel).toBe('Essential');
  });

  it('exposes complete per-point labels and derives endpoints from them', () => {
    const cfg = readMatrixConfig({
      rows,
      scale: { min: 1, max: 3, labels: ['Low', 'Mid', 'High'] },
    });
    expect(cfg?.labels).toEqual(['Low', 'Mid', 'High']);
    expect(cfg?.minLabel).toBe('Low');
    expect(cfg?.maxLabel).toBe('High');
  });

  it('returns null for an unreadable / row-less config', () => {
    expect(readMatrixConfig(null)).toBeNull();
    expect(readMatrixConfig({ rows: [], scale: endpointScale })).toBeNull();
    expect(readMatrixConfig({ scale: endpointScale })).toBeNull();
  });

  it('read schema strips matrix down to rows + scale (unknown keys dropped)', () => {
    const parsed = typeConfigSchemaFor('matrix').safeParse({
      rows,
      scale: endpointScale,
      stray: 'ignored',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('stray');
  });
});
