/**
 * Unit tests for the goal/audience merge (F1.1 / PR4, T1.4.2).
 *
 * Pure function — no mocks. Covers the admin-wins-per-field precedence, the
 * inferred and pre-existing arms, per-field provenance tagging, and the
 * never-blank-a-set-field guarantee.
 */

import { describe, it, expect } from 'vitest';

import { mergeGoalAudience } from '@/app/api/v1/app/questionnaires/_lib/merge';

describe('mergeGoalAudience — goal', () => {
  it('prefers the admin goal over the inferred goal and tags it admin-supplied', () => {
    const result = mergeGoalAudience({
      admin: { goal: 'Admin goal' },
      inferred: { goal: 'Inferred goal' },
    });
    expect(result.goal).toBe('Admin goal');
    expect(result.provenance.goal).toBe('admin-supplied');
  });

  it('falls back to the inferred goal when the admin supplied none', () => {
    const result = mergeGoalAudience({ inferred: { goal: 'Inferred goal' } });
    expect(result.goal).toBe('Inferred goal');
    expect(result.provenance.goal).toBe('inferred');
  });

  it('keeps a pre-existing goal when neither admin nor inference provide one', () => {
    const result = mergeGoalAudience({ existing: { goal: 'Existing goal' } });
    expect(result.goal).toBe('Existing goal');
    expect(result.provenance.goal).toBe('pre-existing');
  });

  it('returns a null goal with no provenance entry when no source provides one', () => {
    const result = mergeGoalAudience({});
    expect(result.goal).toBeNull();
    expect(result.provenance.goal).toBeUndefined();
  });
});

describe('mergeGoalAudience — audience (per-field)', () => {
  it('resolves each field independently across admin, inferred, and existing', () => {
    const result = mergeGoalAudience({
      admin: { audience: { role: 'CFO' } },
      inferred: { audience: { role: 'analyst', expertiseLevel: 'expert' } },
      existing: { audience: { locale: 'en-GB' } },
    });

    expect(result.audience).toEqual({
      role: 'CFO', // admin wins
      expertiseLevel: 'expert', // inferred (admin didn't supply)
      locale: 'en-GB', // pre-existing (neither admin nor inference)
    });
    expect(result.provenance.audience).toEqual({
      role: 'admin-supplied',
      expertiseLevel: 'inferred',
      locale: 'pre-existing',
    });
  });

  it('returns a null audience and empty provenance map when no field resolves', () => {
    const result = mergeGoalAudience({});
    expect(result.audience).toBeNull();
    expect(result.provenance.audience).toEqual({});
  });

  it('never blanks a pre-existing field absent from a re-ingest', () => {
    const result = mergeGoalAudience({
      inferred: { audience: { expertiseLevel: 'novice' } },
      existing: { audience: { role: 'manager' } },
    });
    // The re-ingest only inferred expertiseLevel; the previously-set role survives.
    expect(result.audience).toEqual({ role: 'manager', expertiseLevel: 'novice' });
  });

  it('treats a null existing audience as no prior value', () => {
    const result = mergeGoalAudience({
      admin: { audience: { role: 'lead' } },
      existing: { audience: null },
    });
    expect(result.audience).toEqual({ role: 'lead' });
  });
});
