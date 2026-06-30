/**
 * Unit tests for the Structure Edit Agent request-body schemas (plan + apply).
 *
 * These are the boundary validators (CLAUDE.md: validate at boundaries) — every field arrives as
 * untrusted JSON, so the tests assert the schemas reject off-shape payloads and apply the right
 * defaults, and that the apply body's discriminated union keeps `precise` (op list) and `rewrite`
 * (full structure) from being confused.
 */

import { describe, it, expect } from 'vitest';

import {
  editPlanRequestSchema,
  editApplyRequestSchema,
  MAX_EDIT_INSTRUCTION_CHARS,
} from '@/app/api/v1/app/questionnaires/_lib/edit-agent-input';

// A minimal valid edit-op, used to exercise the `precise` apply branch without re-testing edit-ops.
const VALID_OP = { op: 'set_required', target: { scope: 'all' }, value: true };

describe('editPlanRequestSchema', () => {
  it('accepts a trimmed instruction and defaults mode to "precise"', () => {
    const result = editPlanRequestSchema.parse({ instruction: '  Renumber the sections  ' });
    // .trim() runs as part of parsing — leading/trailing whitespace is stripped.
    expect(result.instruction).toBe('Renumber the sections');
    // mode is optional in the payload; the schema fills the default.
    expect(result.mode).toBe('precise');
  });

  it('accepts an explicit rewrite mode', () => {
    expect(editPlanRequestSchema.parse({ instruction: 'x', mode: 'rewrite' }).mode).toBe('rewrite');
  });

  it('rejects an empty / whitespace-only instruction', () => {
    expect(editPlanRequestSchema.safeParse({ instruction: '' }).success).toBe(false);
    // Whitespace trims to empty, which fails the min(1).
    expect(editPlanRequestSchema.safeParse({ instruction: '   ' }).success).toBe(false);
  });

  it('rejects an instruction over the character cap', () => {
    const tooLong = 'a'.repeat(MAX_EDIT_INSTRUCTION_CHARS + 1);
    expect(editPlanRequestSchema.safeParse({ instruction: tooLong }).success).toBe(false);
    // Exactly at the cap is allowed.
    expect(
      editPlanRequestSchema.safeParse({ instruction: 'a'.repeat(MAX_EDIT_INSTRUCTION_CHARS) })
        .success
    ).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(editPlanRequestSchema.safeParse({ instruction: 'x', mode: 'delete-all' }).success).toBe(
      false
    );
  });
});

describe('editApplyRequestSchema', () => {
  describe('precise branch', () => {
    it('accepts a non-empty operations array', () => {
      const result = editApplyRequestSchema.parse({ mode: 'precise', operations: [VALID_OP] });
      expect(result.mode).toBe('precise');
      expect(result).toMatchObject({ operations: [VALID_OP] });
    });

    it('rejects an empty operations array (min 1)', () => {
      expect(editApplyRequestSchema.safeParse({ mode: 'precise', operations: [] }).success).toBe(
        false
      );
    });

    it('rejects more than 50 operations (max 50)', () => {
      const ops = Array.from({ length: 51 }, () => VALID_OP);
      expect(editApplyRequestSchema.safeParse({ mode: 'precise', operations: ops }).success).toBe(
        false
      );
    });

    it('rejects an operation that is not a valid edit-op', () => {
      const bad = { op: 'not_a_real_op', target: { scope: 'all' } };
      expect(editApplyRequestSchema.safeParse({ mode: 'precise', operations: [bad] }).success).toBe(
        false
      );
    });

    it('does not accept a structure field on the precise branch', () => {
      // The union discriminates on mode: a precise body must carry operations, not a structure.
      expect(editApplyRequestSchema.safeParse({ mode: 'precise', structure: {} }).success).toBe(
        false
      );
    });
  });

  describe('rewrite branch', () => {
    it('requires a structure field', () => {
      // mode=rewrite with no structure must fail (and must not fall back to the precise branch).
      expect(editApplyRequestSchema.safeParse({ mode: 'rewrite' }).success).toBe(false);
    });

    it('rejects an off-shape structure (extraction-schema contract enforced)', () => {
      expect(
        editApplyRequestSchema.safeParse({ mode: 'rewrite', structure: { nope: true } }).success
      ).toBe(false);
    });
  });

  it('rejects an unknown mode discriminator', () => {
    expect(
      editApplyRequestSchema.safeParse({ mode: 'sideways', operations: [VALID_OP] }).success
    ).toBe(false);
  });
});
