/**
 * Respondent Report worker — unit tests (lease claim + drive).
 *
 * @see lib/app/questionnaire/report/worker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appRespondentReport: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/app/questionnaire/report/generate', () => ({
  generateRespondentReport: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { generateRespondentReport } from '@/lib/app/questionnaire/report/generate';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default claim chain: one candidate, claim wins, hydrate it. Override per test.
  (prisma.appRespondentReport.findFirst as Mock).mockResolvedValueOnce({ id: 'r1' });
  (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 1 });
  (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
    id: 'r1',
    sessionId: 'sess-1',
  });
  // After the first drain iteration, no more candidates.
  (prisma.appRespondentReport.findFirst as Mock).mockResolvedValue(null);
});

describe('processQueuedRespondentReports', () => {
  it('returns zeros when nothing is claimable', async () => {
    (prisma.appRespondentReport.findFirst as Mock).mockReset();
    (prisma.appRespondentReport.findFirst as Mock).mockResolvedValue(null);

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(prisma.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('claims a report, generates it, and marks it ready with content + cost', async () => {
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.0123,
    });

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(generateRespondentReport).toHaveBeenCalledWith('sess-1');

    // The terminal write: status ready + content + cost + cleared lease, guarded on processing.
    const readyWrite = (prisma.appRespondentReport.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'ready'
    );
    if (!readyWrite) throw new Error('expected a ready write');
    expect(readyWrite[0].where).toMatchObject({ id: 'r1', status: 'processing' });
    expect(readyWrite[0].data).toMatchObject({
      status: 'ready',
      costUsd: 0.0123,
      lockedBy: null,
      lockedAt: null,
    });
  });

  it('marks the report failed (lease cleared) when generation throws', async () => {
    (generateRespondentReport as Mock).mockRejectedValue(new Error('no provider'));

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const failWrite = (prisma.appRespondentReport.updateMany as Mock).mock.calls.find(
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
    (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 0 });

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(generateRespondentReport).not.toHaveBeenCalled();
  });
});
