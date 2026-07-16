/**
 * Respondent Report revision worker — unit tests (admin re-run drain).
 *
 * Mirrors the delivered-report worker tests but for `processQueuedReportRevisions`: it claims a queued
 * revision under a lease, generates with the SNAPSHOT settings (never the version config), and writes the
 * result onto the REVISION — never the delivered report.
 *
 * @see lib/app/questionnaire/report/worker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appRespondentReportRevision: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/app/questionnaire/report/generate', () => ({
  generateRespondentReport: vi.fn(),
  generateRespondentReportWithSettings: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { generateRespondentReportWithSettings } from '@/lib/app/questionnaire/report/generate';
import { processQueuedReportRevisions } from '@/lib/app/questionnaire/report/worker';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appRespondentReportRevision.findFirst as Mock).mockResolvedValueOnce({ id: 'rev1' });
  (prisma.appRespondentReportRevision.updateMany as Mock).mockResolvedValue({ count: 1 });
  (prisma.appRespondentReportRevision.count as Mock).mockResolvedValue(0);
  (prisma.appRespondentReportRevision.findUnique as Mock).mockResolvedValue({
    id: 'rev1',
    settingsSnapshot: { enabled: true, mode: 'narrative' },
    report: { sessionId: 'sess-1' },
  });
  (prisma.appRespondentReportRevision.findFirst as Mock).mockResolvedValue(null);
});

describe('processQueuedReportRevisions', () => {
  it('returns zeros when nothing is claimable', async () => {
    (prisma.appRespondentReportRevision.findFirst as Mock).mockReset();
    (prisma.appRespondentReportRevision.findFirst as Mock).mockResolvedValue(null);

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(prisma.appRespondentReportRevision.updateMany).not.toHaveBeenCalled();
  });

  it('claims a revision, generates with the snapshot settings, and writes ready onto the revision', async () => {
    (generateRespondentReportWithSettings as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.02,
      formatted: true,
      completionPct: 75,
    });

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    // Generated with the session id + the NARROWED snapshot settings (not the version config).
    expect(generateRespondentReportWithSettings).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ mode: 'narrative' })
    );

    const readyWrite = (prisma.appRespondentReportRevision.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'ready'
    );
    if (!readyWrite) throw new Error('expected a ready write');
    expect(readyWrite[0].where).toMatchObject({ id: 'rev1', status: 'processing' });
    expect(readyWrite[0].data).toMatchObject({
      status: 'ready',
      content: { summary: 'ok', sections: [], actions: [] },
      formatted: true,
      completionPct: 75,
      costUsd: 0.02,
      lockedBy: null,
      lockedAt: null,
    });
  });

  it('marks the revision failed (lease cleared) when generation throws', async () => {
    (generateRespondentReportWithSettings as Mock).mockRejectedValue(new Error('no provider'));

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const failWrite = (prisma.appRespondentReportRevision.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'failed'
    );
    if (!failWrite) throw new Error('expected a failed write');
    expect(failWrite[0].data).toMatchObject({
      status: 'failed',
      error: 'no provider',
      lockedBy: null,
      lockedAt: null,
    });
  });

  it('does not generate when the claim race is lost (updateMany count 0)', async () => {
    (prisma.appRespondentReportRevision.updateMany as Mock).mockResolvedValue({ count: 0 });

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(generateRespondentReportWithSettings).not.toHaveBeenCalled();
  });

  it('does not generate when the claimed row vanishes before rehydration (findUnique null)', async () => {
    // The candidate is claimed (updateMany count 1) but the follow-up read finds nothing.
    (prisma.appRespondentReportRevision.findUnique as Mock).mockResolvedValue(null);

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(generateRespondentReportWithSettings).not.toHaveBeenCalled();
  });

  it('warns when a full batch (MAX_PER_TICK) leaves a large backlog', async () => {
    // Always-claimable: every findFirst returns a candidate so the loop drains the full batch of 5.
    (prisma.appRespondentReportRevision.findFirst as Mock).mockReset();
    (prisma.appRespondentReportRevision.findFirst as Mock).mockResolvedValue({ id: 'rev1' });
    (generateRespondentReportWithSettings as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.02,
      formatted: true,
      completionPct: 75,
    });
    (prisma.appRespondentReportRevision.count as Mock).mockResolvedValue(25); // ≥ BACKLOG_WARN_THRESHOLD (20)

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 5, succeeded: 5, failed: 0 });
    expect(prisma.appRespondentReportRevision.count).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'respondent report revision backlog',
      expect.objectContaining({ backlog: 25, drainedThisTick: 5 })
    );
  });

  it('does not warn when a full batch leaves only a small backlog', async () => {
    (prisma.appRespondentReportRevision.findFirst as Mock).mockReset();
    (prisma.appRespondentReportRevision.findFirst as Mock).mockResolvedValue({ id: 'rev1' });
    (generateRespondentReportWithSettings as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.02,
      formatted: true,
      completionPct: 75,
    });
    (prisma.appRespondentReportRevision.count as Mock).mockResolvedValue(3); // < BACKLOG_WARN_THRESHOLD

    const result = await processQueuedReportRevisions();
    expect(result).toEqual({ claimed: 5, succeeded: 5, failed: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
