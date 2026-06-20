/**
 * Unit: cohort/round request schemas + the default-round-name helper.
 */

import { describe, it, expect } from 'vitest';

import {
  createCohortSchema,
  updateCohortSchema,
  createCohortMemberSchema,
  updateCohortMemberSchema,
  createRoundSchema,
  updateRoundSchema,
  attachRoundQuestionnaireSchema,
  defaultRoundName,
} from '@/lib/app/questionnaire/rounds';

describe('createCohortSchema', () => {
  it('requires demoClientId and name; trims and nulls an empty description', () => {
    const parsed = createCohortSchema.parse({
      demoClientId: 'dc-1',
      name: '  Leadership  ',
      description: '   ',
    });
    expect(parsed).toMatchObject({ demoClientId: 'dc-1', name: 'Leadership', description: null });
  });

  it('rejects a blank name', () => {
    expect(createCohortSchema.safeParse({ demoClientId: 'dc-1', name: '   ' }).success).toBe(false);
  });
});

describe('updateCohortSchema', () => {
  it('requires at least one field', () => {
    expect(updateCohortSchema.safeParse({}).success).toBe(false);
  });

  it('coerces an empty description to null', () => {
    const parsed = updateCohortSchema.parse({ description: '   ' });
    expect(parsed.description).toBeNull();
  });
});

describe('createCohortMemberSchema', () => {
  it('lowercases the email and requires a name', () => {
    const parsed = createCohortMemberSchema.parse({ email: 'Jo@Acme.COM', name: 'Jo' });
    expect(parsed.email).toBe('jo@acme.com');
  });

  it('rejects an invalid email', () => {
    expect(createCohortMemberSchema.safeParse({ email: 'nope', name: 'Jo' }).success).toBe(false);
  });
});

describe('updateCohortMemberSchema', () => {
  it('accepts status "active" (re-activation) but rejects "removed"', () => {
    expect(updateCohortMemberSchema.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateCohortMemberSchema.safeParse({ status: 'removed' }).success).toBe(false);
  });

  it('requires at least one field', () => {
    expect(updateCohortMemberSchema.safeParse({}).success).toBe(false);
  });
});

describe('attachRoundQuestionnaireSchema', () => {
  it('requires a questionnaireId and accepts an optional nullable versionId', () => {
    expect(attachRoundQuestionnaireSchema.safeParse({ questionnaireId: 'q-1' }).success).toBe(true);
    expect(
      attachRoundQuestionnaireSchema.safeParse({ questionnaireId: 'q-1', versionId: null }).success
    ).toBe(true);
    expect(attachRoundQuestionnaireSchema.safeParse({ versionId: 'v-1' }).success).toBe(false);
  });
});

describe('createRoundSchema', () => {
  it('accepts a window and coerces ISO strings to Dates', () => {
    const parsed = createRoundSchema.parse({
      cohortId: 'co-1',
      opensAt: '2026-07-01T00:00:00.000Z',
      closesAt: '2026-07-31T00:00:00.000Z',
    });
    expect(parsed.opensAt).toBeInstanceOf(Date);
    expect(parsed.closesAt).toBeInstanceOf(Date);
  });

  it('rejects a close date before the open date', () => {
    const r = createRoundSchema.safeParse({
      cohortId: 'co-1',
      opensAt: '2026-07-31T00:00:00.000Z',
      closesAt: '2026-07-01T00:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });

  it('allows name to be omitted (derived server-side)', () => {
    expect(createRoundSchema.safeParse({ cohortId: 'co-1' }).success).toBe(true);
  });
});

describe('updateRoundSchema', () => {
  it('allows status draft|open but not closed (close is its own action)', () => {
    expect(updateRoundSchema.safeParse({ status: 'open' }).success).toBe(true);
    expect(updateRoundSchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('requires at least one field', () => {
    expect(updateRoundSchema.safeParse({}).success).toBe(false);
  });
});

describe('defaultRoundName', () => {
  const opens = new Date('2026-07-01T00:00:00.000Z');
  const closes = new Date('2026-07-31T00:00:00.000Z');

  it('uses the cohort name + both dates when windowed', () => {
    expect(defaultRoundName('Acme Team', opens, closes)).toBe(
      'Acme Team · 1 Jul 2026 – 31 Jul 2026'
    );
  });

  it('falls back to "<cohort> round" with no dates', () => {
    expect(defaultRoundName('Acme Team', null, null)).toBe('Acme Team round');
  });

  it('handles a single bound', () => {
    expect(defaultRoundName('Acme Team', opens, null)).toBe('Acme Team · from 1 Jul 2026');
    expect(defaultRoundName('Acme Team', null, closes)).toBe('Acme Team · until 31 Jul 2026');
  });
});
