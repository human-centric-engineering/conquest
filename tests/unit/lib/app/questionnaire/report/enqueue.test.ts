/**
 * Respondent Report enqueue — unit tests (the submit-time trigger gate).
 *
 * @see lib/app/questionnaire/report/enqueue.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appRespondentReport: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  enqueueRespondentReport,
  generateDeliveredRespondentReport,
} from '@/lib/app/questionnaire/report/enqueue';

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
  (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(enabledConfig());
  (prisma.appRespondentReport.upsert as Mock).mockResolvedValue({});
});

describe('enqueueRespondentReport', () => {
  it('queues a report when the version is in insights mode', async () => {
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

  it('does nothing when the report is disabled for the version', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: false, mode: 'raw_plus_insights' } } },
    });
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(false);
    expect(prisma.appRespondentReport.upsert).not.toHaveBeenCalled();
  });

  it('queues a report for narrative mode (an AI mode, generated async)', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: true, mode: 'narrative' } } },
    });
    await expect(enqueueRespondentReport('sess-1')).resolves.toBe(true);
    const arg = (prisma.appRespondentReport.upsert as Mock).mock.calls[0][0];
    expect(arg.create).toMatchObject({ sessionId: 'sess-1', mode: 'narrative', status: 'queued' });
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

/**
 * The admin "Generate report" path — unlike the idempotent submit-time enqueue, this FORCE-queues an
 * inert header (a `ready`-with-null-content placeholder, or a `failed` row) that a plain upsert would
 * leave untouched, while refusing to clobber a real report or an in-flight generation.
 */
describe('generateDeliveredRespondentReport', () => {
  it('refuses when the report is disabled or not an AI mode', async () => {
    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: false, mode: 'narrative' } } },
    });
    await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(false);

    (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      version: { config: { respondentReport: { enabled: true, mode: 'raw' } } },
    });
    await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(false);

    expect(prisma.appRespondentReport.create).not.toHaveBeenCalled();
    expect(prisma.appRespondentReport.update).not.toHaveBeenCalled();
  });

  it('creates a queued header when the session has none', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue(null);
    (prisma.appRespondentReport.create as Mock).mockResolvedValue({});

    await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(true);
    expect(prisma.appRespondentReport.create).toHaveBeenCalledWith({
      data: { sessionId: 'sess-1', mode: 'raw_plus_insights', status: 'queued' },
    });
  });

  it('refuses to clobber a report that already has content, or one already in flight', async () => {
    for (const existing of [
      { status: 'ready', content: { summary: 'S' } },
      { status: 'processing', content: null },
      { status: 'queued', content: null },
    ]) {
      vi.clearAllMocks();
      (prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(enabledConfig());
      (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue(existing);

      await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(false);
      expect(prisma.appRespondentReport.update).not.toHaveBeenCalled();
      expect(prisma.appRespondentReport.create).not.toHaveBeenCalled();
    }
  });

  it('re-queues an inert header (ready-with-no-content) and clears any prior error + lease', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      status: 'ready',
      content: null,
    });
    (prisma.appRespondentReport.update as Mock).mockResolvedValue({});

    await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(true);
    expect(prisma.appRespondentReport.update).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1' },
      data: {
        status: 'queued',
        mode: 'raw_plus_insights',
        error: null,
        lockedBy: null,
        lockedAt: null,
      },
    });
  });

  it('re-queues a failed report', async () => {
    (prisma.appRespondentReport.findUnique as Mock).mockResolvedValue({
      status: 'failed',
      content: null,
    });
    (prisma.appRespondentReport.update as Mock).mockResolvedValue({});

    await expect(generateDeliveredRespondentReport('sess-1')).resolves.toBe(true);
    expect(prisma.appRespondentReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued', error: null }) })
    );
  });
});
