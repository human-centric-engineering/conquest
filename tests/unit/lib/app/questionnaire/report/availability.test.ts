/**
 * Unit test: admin report availability resolver.
 *
 * Pins the Report-tab state machine: a report that exists → `exists`; no AI report configured →
 * `disabled`; no report yet → `generate` when completed or (in progress) when the questionnaire allows
 * early reports with answers captured, else `not_yet`.
 */

import { describe, it, expect } from 'vitest';

import { resolveAdminReportAvailability } from '@/lib/app/questionnaire/report/availability';

const base = {
  enabled: true,
  hasReport: false,
  sessionStatus: 'active' as const,
  answeredCount: 5,
  allowEarlyFinish: false,
};

describe('resolveAdminReportAvailability', () => {
  it('returns `exists` whenever a report is present (regardless of other signals)', () => {
    expect(resolveAdminReportAvailability({ ...base, hasReport: true }).state).toBe('exists');
    expect(resolveAdminReportAvailability({ ...base, hasReport: true, enabled: false }).state).toBe(
      'exists'
    );
  });

  it('treats an in-flight (generating) report as `exists`, even on an ineligible session', () => {
    // Active + early-finish off would otherwise be `not_yet`, but a report is already generating.
    expect(resolveAdminReportAvailability({ ...base, reportInFlight: true }).state).toBe('exists');
  });

  it('returns `disabled` when the questionnaire has no AI report configured', () => {
    expect(resolveAdminReportAvailability({ ...base, enabled: false }).state).toBe('disabled');
  });

  it('offers `generate` for a completed session with no report', () => {
    expect(resolveAdminReportAvailability({ ...base, sessionStatus: 'completed' }).state).toBe(
      'generate'
    );
  });

  it('gates in-progress generation on the early-report setting', () => {
    // Early finish off → must wait for completion.
    expect(resolveAdminReportAvailability({ ...base, allowEarlyFinish: false }).state).toBe(
      'not_yet'
    );
    // Early finish on + answers captured → can generate now.
    expect(resolveAdminReportAvailability({ ...base, allowEarlyFinish: true }).state).toBe(
      'generate'
    );
    // Early finish on but nothing answered yet → not yet.
    expect(
      resolveAdminReportAvailability({ ...base, allowEarlyFinish: true, answeredCount: 0 }).state
    ).toBe('not_yet');
  });

  it('carries a human message for the non-actionable / generate states', () => {
    expect(resolveAdminReportAvailability({ ...base, enabled: false }).message).toMatch(
      /AI report/i
    );
    expect(resolveAdminReportAvailability(base).message).toMatch(/completes/i);
    expect(resolveAdminReportAvailability({ ...base, sessionStatus: 'completed' }).message).toMatch(
      /no report yet/i
    );
  });
});
