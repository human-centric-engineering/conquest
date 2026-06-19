/**
 * Respondent Report enqueue — unit tests (the submit-time trigger gate).
 *
 * @see lib/app/questionnaire/report/enqueue.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appRespondentReport: { upsert: vi.fn() },
  },
}));

import { isFeatureEnabled } from '@/lib/feature-flags';
import { prisma } from '@/lib/db/client';
import { enqueueRespondentReport } from '@/lib/app/questionnaire/report/enqueue';

type Mock = ReturnType<typeof vi.fn>;

/** A config whose respondentReport slice is enabled in insights mode. */
function enabledConfig() {
  return {
    version: {
      config: {
        respondentReport: { enabled: true, mode: 'raw_plus_insights' },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(enabledConfig());
  (prisma.appRespondentReport.upsert as Mock).mockResolvedValue({});
});

describe('enqueueRespondentReport', () => {
  it('queues a report when the flag is on and the version is in insights mode', async () => {
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(true);
    const arg = (prisma.appRespondentReport.upsert as Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ sessionId: 'sess-1' });
    expect(arg.create).toMatchObject({
      sessionId: 'sess-1',
      mode: 'raw_plus_insights',
      status: 'queued',
    });
    // Idempotent — a re-submit must not reset an existing report.
    expect(arg.update).toEqual({});
  });

  it('does nothing when the master flag is off', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
    expect(prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('does nothing when only the respondent-report sub-flag is off (master on)', async () => {
    (isFeatureEnabled as unknown as Mock)
      .mockResolvedValueOnce(true) // master
      .mockResolvedValueOnce(false); // sub-flag
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
    expect(prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('does nothing when the report is disabled for the version', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: false, mode: 'raw_plus_insights' } } },
    });
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
    expect(prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('does nothing for raw mode (no row needed — renders on demand)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: true, mode: 'raw' } } },
    });
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
    expect(prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('defaults to no-op when the version has no config row', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: null },
    });
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
  });
});
