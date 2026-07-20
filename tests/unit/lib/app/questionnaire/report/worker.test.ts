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
      count: vi.fn(),
    },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/app/questionnaire/report/generate', () => ({
  generateRespondentReport: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/run-report', () => ({
  generateRunReport: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/notify-send', () => ({
  sendRespondentReportReadyEmail: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { generateRespondentReport } from '@/lib/app/questionnaire/report/generate';
import { generateRunReport } from '@/lib/app/questionnaire/report/run-report';
import { sendRespondentReportReadyEmail } from '@/lib/app/questionnaire/report/notify-send';
import { processQueuedRespondentReports } from '@/lib/app/questionnaire/report/worker';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default claim chain: one candidate, claim wins, hydrate it. Override per test.
  (prisma.appRespondentReport.findFirst as Mock).mockResolvedValueOnce({ id: 'r1' });
  (prisma.appRespondentReport.updateMany as Mock).mockResolvedValue({ count: 1 });
  (prisma.appRespondentReport.count as Mock).mockResolvedValue(0);
  (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
    id: 'r1',
    sessionId: 'sess-1',
    runId: null,
    notifyEmail: null,
  });
  // After the first drain iteration, no more candidates.
  (prisma.appRespondentReport.findFirst as Mock).mockResolvedValue(null);
  (sendRespondentReportReadyEmail as Mock).mockResolvedValue({ success: true, status: 'sent' });
});

describe('processQueuedRespondentReports', () => {
  it('returns zeros when nothing is claimable', async () => {
    (prisma.appRespondentReport.findFirst as Mock).mockReset();
    (prisma.appRespondentReport.findFirst as Mock).mockResolvedValue(null);

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(prisma.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('claims a report, generates it, and marks it ready with content + cost + formatted', async () => {
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.0123,
      formatted: true,
      completionPct: 60,
    });

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(generateRespondentReport).toHaveBeenCalledWith('sess-1');

    // The terminal write: status ready + content + cost + formatted flag + cleared lease, guarded on processing.
    const readyWrite = (prisma.appRespondentReport.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'ready'
    );
    if (!readyWrite) throw new Error('expected a ready write');
    expect(readyWrite[0].where).toMatchObject({ id: 'r1', status: 'processing' });
    expect(readyWrite[0].data).toMatchObject({
      status: 'ready',
      content: { summary: 'ok', sections: [], actions: [] },
      formatted: true,
      completionPct: 60,
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

  it('sends the report-ready email when the row has a notifyEmail, and clears it on the ready write', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      id: 'r1',
      sessionId: 'sess-1',
      runId: null,
      notifyEmail: 'you@example.com',
    });
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.01,
    });

    await processQueuedRespondentReports();

    expect(sendRespondentReportReadyEmail).toHaveBeenCalledWith(
      { sessionId: 'sess-1' },
      'you@example.com'
    );
    // The ready write clears notifyEmail so a later re-drain never re-sends.
    const readyWrite = (prisma.appRespondentReport.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'ready'
    );
    expect(readyWrite?.[0].data).toMatchObject({ notifyEmail: null });
  });

  it('does not send an email when the row has no notifyEmail', async () => {
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.01,
    });

    await processQueuedRespondentReports();
    expect(sendRespondentReportReadyEmail).not.toHaveBeenCalled();
  });

  it('still marks the report ready when the email send throws (best-effort)', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      id: 'r1',
      sessionId: 'sess-1',
      runId: null,
      notifyEmail: 'you@example.com',
    });
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.01,
    });
    (sendRespondentReportReadyEmail as Mock).mockRejectedValue(new Error('smtp down'));

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it('warns when a full batch (MAX_PER_TICK) leaves a large backlog', async () => {
    // Drain a full batch of 5: one candidate per iteration, then no more.
    (prisma.appRespondentReport.findFirst as Mock).mockReset();
    (prisma.appRespondentReport.findFirst as Mock)
      .mockResolvedValueOnce({ id: 'r1' })
      .mockResolvedValueOnce({ id: 'r2' })
      .mockResolvedValueOnce({ id: 'r3' })
      .mockResolvedValueOnce({ id: 'r4' })
      .mockResolvedValueOnce({ id: 'r5' })
      .mockResolvedValue(null);
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.01,
    });
    // 25 still waiting after the batch → above the backlog threshold (20).
    (prisma.appRespondentReport.count as Mock).mockResolvedValue(25);

    const result = await processQueuedRespondentReports();

    expect(result.claimed).toBe(5);
    expect(prisma.appRespondentReport.count).toHaveBeenCalledWith({
      where: { status: { in: ['queued', 'processing'] } },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'respondent report backlog',
      expect.objectContaining({ backlog: 25 })
    );
  });

  it('does not query the backlog when the batch was not full', async () => {
    // Default beforeEach drains a single report (< MAX_PER_TICK).
    (generateRespondentReport as Mock).mockResolvedValue({
      content: { summary: 'ok', sections: [], actions: [] },
      costUsd: 0.01,
    });

    await processQueuedRespondentReports();
    expect(prisma.appRespondentReport.count).not.toHaveBeenCalled();
  });
});

describe('processQueuedRespondentReports — run-scope rows (F15.4b)', () => {
  /**
   * A run-scope row has NO sessionId — the schema says so ("Session-scope owner key. NULL for
   * run-scope rows") and `enqueueRunReport` creates it that way. Every assertion here exists
   * because addressing the send by session alone silently dropped the respondent's opt-in.
   */
  function claimRunRow(notifyEmail: string | null) {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      id: 'r1',
      sessionId: null,
      runId: 'run-1',
      notifyEmail,
    });
  }

  beforeEach(() => {
    (generateRunReport as Mock).mockResolvedValue({
      content: { summary: 'journey', sections: [], actions: [] },
      costUsd: 0.02,
      formatted: true,
      completionPct: 80,
    });
  });

  it('sends the report-ready email for a run report, addressed by runId', async () => {
    claimRunRow('you@example.com');

    const result = await processQueuedRespondentReports();

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(generateRunReport).toHaveBeenCalledWith('run-1');
    expect(sendRespondentReportReadyEmail).toHaveBeenCalledWith(
      { runId: 'run-1' },
      'you@example.com'
    );
  });

  it('clears notifyEmail on the ready write, so a re-drain never re-sends', async () => {
    claimRunRow('you@example.com');

    await processQueuedRespondentReports();

    const readyWrite = (prisma.appRespondentReport.updateMany as Mock).mock.calls.find(
      (c) => c[0]?.data?.status === 'ready'
    );
    expect(readyWrite?.[0].data).toMatchObject({ notifyEmail: null });
  });

  it('does not send when a run report carries no address', async () => {
    claimRunRow(null);

    await processQueuedRespondentReports();
    expect(sendRespondentReportReadyEmail).not.toHaveBeenCalled();
  });

  it('still marks a run report ready when the send throws (best-effort)', async () => {
    claimRunRow('you@example.com');
    (sendRespondentReportReadyEmail as Mock).mockRejectedValue(new Error('smtp down'));

    const result = await processQueuedRespondentReports();
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it('fails an ownerless row terminally rather than trying to email about it', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      id: 'r1',
      sessionId: null,
      runId: null,
      notifyEmail: 'you@example.com',
    });

    const result = await processQueuedRespondentReports();

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(sendRespondentReportReadyEmail).not.toHaveBeenCalled();
  });
});
