/**
 * Launch / preview readiness — pure-logic tests.
 *
 * `readiness.ts` is the single source of the criteria a version must meet before it can be
 * launched OR previewed. Four consumers depend on it (launch checklist UI, status-route launch
 * gate, preview gate, overview page), so the rules are pinned here directly rather than only
 * through those consumers: each base check, the empty-audience edge, and the conditional
 * data-slots check.
 */

import { describe, it, expect } from 'vitest';

import {
  hasAudience,
  isLaunchReady,
  launchReadinessChecks,
  type LaunchReadinessInput,
} from '@/lib/app/questionnaire/launch/readiness';

/** A version that passes every base check (no data-slots requirement). */
const READY: LaunchReadinessInput = {
  goal: 'Understand the prospect',
  audience: { description: 'Prospective customers' },
  sectionCount: 2,
  questionCount: 5,
  configSaved: true,
  dataSlotsRequired: false,
  dataSlotsReady: false,
};

describe('hasAudience', () => {
  it('is true when at least one field is defined', () => {
    expect(hasAudience({ description: 'Customers' })).toBe(true);
    expect(hasAudience({ role: 'Buyer' })).toBe(true);
  });

  it('is false for null, an empty object, or a non-object', () => {
    expect(hasAudience(null)).toBe(false);
    expect(hasAudience({})).toBe(false);
    expect(hasAudience('audience')).toBe(false);
    expect(hasAudience(['description'])).toBe(false);
  });

  it('is false when every field is null/undefined (a persisted-but-empty shape)', () => {
    expect(hasAudience({ description: undefined, role: null })).toBe(false);
  });
});

describe('launchReadinessChecks', () => {
  it('passes all five base checks for a ready version (no data-slots row when not required)', () => {
    const checks = launchReadinessChecks(READY);
    expect(checks.map((c) => c.key)).toEqual([
      'goal',
      'audience',
      'sections',
      'questions',
      'config',
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('treats a blank/whitespace goal as not set', () => {
    expect(launchReadinessChecks({ ...READY, goal: '   ' }).find((c) => c.key === 'goal')?.ok).toBe(
      false
    );
    expect(launchReadinessChecks({ ...READY, goal: null }).find((c) => c.key === 'goal')?.ok).toBe(
      false
    );
  });

  it('requires ≥1 section and ≥1 question', () => {
    const noSections = launchReadinessChecks({ ...READY, sectionCount: 0 });
    expect(noSections.find((c) => c.key === 'sections')?.ok).toBe(false);
    const noQuestions = launchReadinessChecks({ ...READY, questionCount: 0 });
    expect(noQuestions.find((c) => c.key === 'questions')?.ok).toBe(false);
  });

  it('requires a saved config row', () => {
    expect(
      launchReadinessChecks({ ...READY, configSaved: false }).find((c) => c.key === 'config')?.ok
    ).toBe(false);
  });

  it('adds the data-slots check only when required, reflecting readiness', () => {
    expect(launchReadinessChecks(READY).some((c) => c.key === 'dataSlots')).toBe(false);

    const notReady = launchReadinessChecks({
      ...READY,
      dataSlotsRequired: true,
      dataSlotsReady: false,
    });
    expect(notReady.find((c) => c.key === 'dataSlots')?.ok).toBe(false);

    const ready = launchReadinessChecks({
      ...READY,
      dataSlotsRequired: true,
      dataSlotsReady: true,
    });
    expect(ready.find((c) => c.key === 'dataSlots')?.ok).toBe(true);
  });
});

describe('isLaunchReady', () => {
  it('is true only when every applicable check passes', () => {
    expect(isLaunchReady(READY)).toBe(true);
    expect(isLaunchReady({ ...READY, audience: {} })).toBe(false);
    expect(isLaunchReady({ ...READY, dataSlotsRequired: true, dataSlotsReady: false })).toBe(false);
    expect(isLaunchReady({ ...READY, dataSlotsRequired: true, dataSlotsReady: true })).toBe(true);
  });
});
