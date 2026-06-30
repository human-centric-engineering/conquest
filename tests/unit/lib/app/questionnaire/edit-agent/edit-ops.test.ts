/**
 * Unit tests for the edit-op boundary schema (`editOpSchema` / `editPlanSchema`).
 *
 * The apply route trusts these to reject malformed ops arriving as JSON, so the tests assert the
 * validator actually accepts well-formed ops and rejects the specific malformations that matter
 * (unknown op, off-range weight, empty key-selector, bad transform).
 */

import { describe, it, expect } from 'vitest';

import {
  editOpSchema,
  editPlanSchema,
  validateEditPlan,
} from '@/lib/app/questionnaire/edit-agent/edit-ops';

describe('editOpSchema', () => {
  it('accepts a well-formed set_required op', () => {
    const parsed = editOpSchema.safeParse({
      op: 'set_required',
      target: { scope: 'type', questionType: 'free_text' },
      value: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown op', () => {
    expect(editOpSchema.safeParse({ op: 'delete_everything' }).success).toBe(false);
  });

  it('rejects a weight outside 0.1–1.0', () => {
    expect(
      editOpSchema.safeParse({ op: 'set_weight', target: { scope: 'all' }, value: 2 }).success
    ).toBe(false);
  });

  it('rejects an empty keys selector', () => {
    expect(
      editOpSchema.safeParse({
        op: 'set_required',
        target: { scope: 'keys', keys: [] },
        value: true,
      }).success
    ).toBe(false);
  });

  it('rejects an invalid transform', () => {
    expect(
      editOpSchema.safeParse({
        op: 'transform_title',
        target: { scope: 'all' },
        transform: 'rot13',
      }).success
    ).toBe(false);
  });

  it('rejects an unknown question type in a selector', () => {
    expect(
      editOpSchema.safeParse({
        op: 'set_required',
        target: { scope: 'type', questionType: 'paragraph' },
        value: true,
      }).success
    ).toBe(false);
  });
});

describe('editPlanSchema / validateEditPlan', () => {
  it('accepts a summary + operations array', () => {
    const plan = {
      summary: 'Make free-text optional',
      operations: [
        { op: 'set_required', target: { scope: 'type', questionType: 'free_text' }, value: false },
      ],
    };
    expect(validateEditPlan(plan)).not.toBeNull();
    expect(editPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('returns null on a malformed plan (validateEditPlan)', () => {
    expect(validateEditPlan({ summary: '', operations: 'nope' })).toBeNull();
    expect(validateEditPlan(null)).toBeNull();
  });

  it('rejects more than 50 operations', () => {
    const operations = Array.from({ length: 51 }, () => ({
      op: 'set_required',
      target: { scope: 'all' },
      value: true,
    }));
    expect(editPlanSchema.safeParse({ summary: 'too many', operations }).success).toBe(false);
  });
});
