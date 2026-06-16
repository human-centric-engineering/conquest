/**
 * Sensitivity detector schema + normalizer — unit tests.
 *
 * The schema is deliberately permissive so a half-populated "detected": true is never discarded;
 * `normalizeSensitivityVerdict` fills safe defaults (severity → high) rather than dropping a
 * possible safeguarding disclosure.
 *
 * @see lib/app/questionnaire/sensitivity/detect-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  validateSensitivityDetectVerdict,
  normalizeSensitivityVerdict,
  SENSITIVITY_DEFAULT_CATEGORY,
  SENSITIVITY_DEFAULT_SUMMARY,
} from '@/lib/app/questionnaire/sensitivity/detect-schema';

describe('validateSensitivityDetectVerdict', () => {
  it('accepts a fully-populated detected verdict', () => {
    const res = validateSensitivityDetectVerdict({
      detected: true,
      severity: 'high',
      category: 'workplace abuse',
      summary: 'Reports being mistreated by their manager.',
    });
    expect(res.ok).toBe(true);
  });

  it('accepts a bare {"detected": false}', () => {
    const res = validateSensitivityDetectVerdict({ detected: false });
    expect(res.ok).toBe(true);
  });

  it('accepts detected:true with fields omitted (tolerant — normalizer fills defaults)', () => {
    const res = validateSensitivityDetectVerdict({ detected: true });
    expect(res.ok).toBe(true);
  });

  it('rejects a missing detected flag', () => {
    const res = validateSensitivityDetectVerdict({ severity: 'high' });
    expect(res.ok).toBe(false);
  });

  it('rejects an out-of-enum severity', () => {
    const res = validateSensitivityDetectVerdict({ detected: true, severity: 'critical' });
    expect(res.ok).toBe(false);
  });
});

describe('normalizeSensitivityVerdict', () => {
  it('returns null when nothing was detected', () => {
    expect(normalizeSensitivityVerdict({ detected: false })).toBeNull();
  });

  it('passes through a fully-populated disclosure', () => {
    const out = normalizeSensitivityVerdict({
      detected: true,
      severity: 'medium',
      category: 'bereavement',
      summary: 'Recently bereaved.',
    });
    expect(out).toEqual({
      detected: true,
      severity: 'medium',
      category: 'bereavement',
      summary: 'Recently bereaved.',
    });
  });

  it('defaults an absent severity to high (the cautious safeguarding choice)', () => {
    const out = normalizeSensitivityVerdict({ detected: true });
    expect(out).toEqual({
      detected: true,
      severity: 'high',
      category: SENSITIVITY_DEFAULT_CATEGORY,
      summary: SENSITIVITY_DEFAULT_SUMMARY,
    });
  });

  it('fills safe defaults for blank category/summary rather than dropping the disclosure', () => {
    const out = normalizeSensitivityVerdict({
      detected: true,
      severity: 'high',
      category: '   ',
      summary: '',
    });
    expect(out?.category).toBe(SENSITIVITY_DEFAULT_CATEGORY);
    expect(out?.summary).toBe(SENSITIVITY_DEFAULT_SUMMARY);
  });
});
