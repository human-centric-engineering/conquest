/**
 * Respondent Report retry — unit tests.
 *
 * @see lib/app/questionnaire/report/retry.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appRespondentReport: { updateMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { requestRespondentReportRetry } from '@/lib/app/questionnaire/report/retry';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestRespondentReportRetry', () => {
  it('re-queues a stuck row and clears its error + lease', async () => {
    (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 1 });

    const result = await requestRespondentReportRetry('sess-1');

    expect(result).toEqual({ requeued: true });
    const call = (prisma.appRespondentReport.updateMany as Mock).mock.calls[0][0];
    expect(call.data).toMatchObject({
      status: 'queued',
      error: null,
      lockedBy: null,
      lockedAt: null,
    });
    // Only failed or orphaned-processing rows match — never a fresh in-flight one.
    expect(call.where.sessionId).toBe('sess-1');
    expect(call.where.OR).toEqual([
      { status: 'failed' },
      { status: 'processing', lockedAt: { lt: expect.any(Date) } },
    ]);
  });

  it('reports requeued: false when nothing matched (ready or fresh in-flight)', async () => {
    (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 0 });

    const result = await requestRespondentReportRetry('sess-1');
    expect(result).toEqual({ requeued: false });
  });

  it('scopes the orphan cutoff to the lease TTL in the past', async () => {
    (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 0 });

    const before = Date.now();
    await requestRespondentReportRetry('sess-1');
    const after = Date.now();

    const cutoff: Date = (prisma.appRespondentReport.updateMany as Mock).mock.calls[0][0].where
      .OR[1].lockedAt.lt;
    // 5-minute lease TTL — cutoff is ~5 min before "now".
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5 * 60 * 1000 - 50);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 5 * 60 * 1000 + 50);
  });
});
