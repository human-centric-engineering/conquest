/**
 * Seriousness judge schema — unit tests.
 *
 * Tests the Zod schema (seriousnessVerdictSchema) and the validate helper
 * (validateSeriousnessVerdict) across valid inputs, invalid inputs, default
 * behaviour, and the exported constant.
 *
 * Test Coverage:
 * - seriousnessVerdictSchema: valid parses (serious true/false, explicit reason, omitted reason)
 * - seriousnessVerdictSchema: rejection of missing `serious`, wrong types
 * - seriousnessVerdictSchema: `reason` defaults to '' when omitted
 * - seriousnessVerdictSchema: `reason` is rejected when it exceeds SERIOUSNESS_REASON_MAX
 * - validateSeriousnessVerdict: returns { ok: true, value } for valid input
 * - validateSeriousnessVerdict: returns { ok: false, issues } for invalid input
 * - SERIOUSNESS_REASON_MAX constant value
 *
 * @see lib/app/questionnaire/seriousness/judge-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  seriousnessVerdictSchema,
  validateSeriousnessVerdict,
  SERIOUSNESS_REASON_MAX,
} from '@/lib/app/questionnaire/seriousness/judge-schema';

// ─── SERIOUSNESS_REASON_MAX ──────────────────────────────────────────────────

describe('SERIOUSNESS_REASON_MAX', () => {
  it('is 400', () => {
    // The schema .max() is wired to this constant — assert the value matches
    // the documented contract so a stray edit is caught.
    expect(SERIOUSNESS_REASON_MAX).toBe(400);
  });
});

// ─── seriousnessVerdictSchema — valid inputs ─────────────────────────────────

describe('seriousnessVerdictSchema — valid inputs', () => {
  it('accepts serious=true with a populated reason', () => {
    // Arrange
    const input = { serious: true, reason: 'Looks like a genuine attempt.' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert: parse succeeded and the values are preserved
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.serious).toBe(true);
    expect(result.data.reason).toBe('Looks like a genuine attempt.');
  });

  it('accepts serious=false with a non-empty reason', () => {
    // Arrange
    const input = { serious: false, reason: 'The answer is abusive.' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.serious).toBe(false);
    expect(result.data.reason).toBe('The answer is abusive.');
  });

  it('defaults reason to empty string when omitted', () => {
    // Arrange: only `serious` provided — no `reason` key
    const input = { serious: true };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert: the schema default kicks in
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reason).toBe('');
  });

  it('accepts reason at exactly SERIOUSNESS_REASON_MAX characters', () => {
    // Arrange: boundary value — exactly at the limit
    const input = { serious: false, reason: 'x'.repeat(SERIOUSNESS_REASON_MAX) };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert: max is inclusive
    expect(result.success).toBe(true);
  });

  it('accepts an empty reason string explicitly', () => {
    // Arrange: LLM may emit "" for serious=true
    const input = { serious: true, reason: '' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reason).toBe('');
  });
});

// ─── seriousnessVerdictSchema — invalid inputs ───────────────────────────────

describe('seriousnessVerdictSchema — invalid inputs', () => {
  it('rejects input missing the required `serious` field', () => {
    // Arrange
    const input = { reason: 'Something' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects `serious` as a string instead of boolean', () => {
    // Arrange: LLM sometimes emits "true" as a string
    const input = { serious: 'true', reason: '' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert: strict boolean type
    expect(result.success).toBe(false);
  });

  it('rejects `serious` as null', () => {
    // Arrange
    const input = { serious: null, reason: '' };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects a reason that exceeds SERIOUSNESS_REASON_MAX characters', () => {
    // Arrange: one character over the limit
    const input = { serious: false, reason: 'x'.repeat(SERIOUSNESS_REASON_MAX + 1) };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert: max is exclusive at SERIOUSNESS_REASON_MAX + 1
    expect(result.success).toBe(false);
    if (result.success) return;
    const reasonIssue = result.error.issues.find((i) => i.path.includes('reason'));
    expect(reasonIssue).toBeDefined();
  });

  it('rejects `reason` as a non-string value', () => {
    // Arrange
    const input = { serious: true, reason: 42 };

    // Act
    const result = seriousnessVerdictSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects a completely empty object', () => {
    // Arrange
    const result = seriousnessVerdictSchema.safeParse({});

    // Assert
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    // Arrange
    const result = seriousnessVerdictSchema.safeParse(null);

    // Assert
    expect(result.success).toBe(false);
  });
});

// ─── validateSeriousnessVerdict ──────────────────────────────────────────────

describe('validateSeriousnessVerdict', () => {
  it('returns { ok: true, value } with the parsed data for valid input', () => {
    // Arrange
    const input = { serious: false, reason: 'Keyboard mashing.' };

    // Act
    const result = validateSeriousnessVerdict(input);

    // Assert: function wraps parse result in its own discriminated union
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.serious).toBe(false);
    expect(result.value.reason).toBe('Keyboard mashing.');
  });

  it('applies the reason default when reason is omitted', () => {
    // Arrange
    const input = { serious: true };

    // Act
    const result = validateSeriousnessVerdict(input);

    // Assert: the default is visible through the validate helper, not just parse
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reason).toBe('');
  });

  it('returns { ok: false, issues } with Zod issues for invalid input', () => {
    // Arrange: missing required field
    const input = { reason: 'No serious field' };

    // Act
    const result = validateSeriousnessVerdict(input);

    // Assert: failure path returns the raw Zod issues array
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('returns ok: false with issues when reason is too long', () => {
    // Arrange
    const input = { serious: true, reason: 'a'.repeat(SERIOUSNESS_REASON_MAX + 1) };

    // Act
    const result = validateSeriousnessVerdict(input);

    // Assert
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // At least one issue should reference 'reason'
    const paths = result.issues.flatMap((i) => i.path.map(String));
    expect(paths).toContain('reason');
  });

  it('returns ok: false for completely unknown input (null)', () => {
    // Arrange
    const result = validateSeriousnessVerdict(null);

    // Assert
    expect(result.ok).toBe(false);
  });
});
