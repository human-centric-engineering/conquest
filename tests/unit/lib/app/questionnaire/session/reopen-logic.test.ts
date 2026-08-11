/**
 * Unit test: reopen eligibility — pure decider (F-early-finish-reopen).
 *
 * `isReopenEligible` is the ONLY gate the reopen seam (`reopenSession`) may rely on before
 * writing the `completed → active` exception — see `session/session-logic.ts` for why this is
 * deliberately NOT part of the shared `LEGAL_TRANSITIONS` matrix. Pins that all four inputs
 * must hold, and that any single one failing refuses reopen.
 */

import { describe, it, expect } from 'vitest';

import {
  isReopenEligible,
  type ReopenEligibilityInput,
} from '@/lib/app/questionnaire/session/reopen-logic';

function input(over: Partial<ReopenEligibilityInput> = {}): ReopenEligibilityInput {
  return {
    status: 'completed',
    allowEarlyFinish: true,
    isExperienceLeg: false,
    latestCompletedReason: 'respondent_early_finish',
    ...over,
  };
}

describe('isReopenEligible', () => {
  it('is eligible when all four conditions hold', () => {
    expect(isReopenEligible(input())).toBe(true);
  });

  it('is NOT eligible when the session is not completed', () => {
    expect(isReopenEligible(input({ status: 'active' }))).toBe(false);
    expect(isReopenEligible(input({ status: 'paused' }))).toBe(false);
    expect(isReopenEligible(input({ status: 'abandoned' }))).toBe(false);
    expect(isReopenEligible(input({ status: 'aborted' }))).toBe(false);
  });

  it('is NOT eligible when allowEarlyFinish is off (even if it was on at the original early finish)', () => {
    expect(isReopenEligible(input({ allowEarlyFinish: false }))).toBe(false);
  });

  it('is NOT eligible for an experience-run leg', () => {
    expect(isReopenEligible(input({ isExperienceLeg: true }))).toBe(false);
  });

  it('is NOT eligible when the most recent completion was a normal full submit', () => {
    expect(isReopenEligible(input({ latestCompletedReason: 'respondent_submit' }))).toBe(false);
  });

  it('is NOT eligible when there is no recorded completion reason', () => {
    expect(isReopenEligible(input({ latestCompletedReason: null }))).toBe(false);
  });
});
