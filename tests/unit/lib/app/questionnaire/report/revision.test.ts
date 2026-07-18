/**
 * Respondent Report revisions — unit tests (admin "re-run report").
 *
 * Covers the append-only re-run model: header creation is inert (`ready`, not `queued`, so the
 * delivered-report worker never picks it up), revision numbering is monotonic, promote copies a `ready`
 * revision onto the delivered report (and is a no-op otherwise), and the view/detail reads shape the
 * admin history.
 *
 * @see lib/app/questionnaire/report/revision.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const headerUpsert = vi.fn();
const headerFindUnique = vi.fn();
const headerUpdate = vi.fn();
const revFindFirst = vi.fn();
const revFindUnique = vi.fn();
const revFindMany = vi.fn();
const revCreate = vi.fn();

vi.mock('@/lib/db/client', () => {
  const appRespondentReport = {
    upsert: (...a: unknown[]) => headerUpsert(...a),
    findUnique: (...a: unknown[]) => headerFindUnique(...a),
    update: (...a: unknown[]) => headerUpdate(...a),
  };
  const appRespondentReportRevision = {
    findFirst: (...a: unknown[]) => revFindFirst(...a),
    findUnique: (...a: unknown[]) => revFindUnique(...a),
    findMany: (...a: unknown[]) => revFindMany(...a),
    create: (...a: unknown[]) => revCreate(...a),
  };
  return {
    prisma: {
      appRespondentReport,
      appRespondentReportRevision,
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ appRespondentReportRevision, appRespondentReport }),
    },
  };
});

import {
  enqueueRespondentReportRevision,
  ensureRespondentReportHeader,
  getRespondentReportRevisionsView,
  getRespondentReportRevisionDetail,
  promoteRespondentReportRevision,
} from '@/lib/app/questionnaire/report/revision';
import { DEFAULT_RESPONDENT_REPORT_SETTINGS } from '@/lib/app/questionnaire/types';

const settings = { ...DEFAULT_RESPONDENT_REPORT_SETTINGS, mode: 'narrative' as const };
const content = { summary: 'S', sections: [], actions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  headerUpsert.mockResolvedValue({ id: 'rep1' });
  revCreate.mockResolvedValue({ id: 'rev-new' });
});

describe('ensureRespondentReportHeader', () => {
  it('creates an inert `ready` header (never `queued`) so the delivered worker never claims it', async () => {
    await ensureRespondentReportHeader('sess-1', 'narrative');
    expect(headerUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess-1' },
        create: { sessionId: 'sess-1', mode: 'narrative', status: 'ready' },
        update: {},
      })
    );
  });
});

describe('enqueueRespondentReportRevision', () => {
  it('appends the next revision number and stores the settings snapshot + note', async () => {
    // Explicit: no rev-0 baseline exists AND there is no delivered header to snapshot, so the
    // baseline step is skipped for a stated reason rather than incidentally (an unset mock).
    revFindUnique.mockResolvedValue(null);
    headerFindUnique.mockResolvedValue(null);
    revFindFirst.mockResolvedValue({ revisionNumber: 2 });

    const out = await enqueueRespondentReportRevision({
      sessionId: 'sess-1',
      settings,
      instructions: '  warmer tone  ',
      adminId: 'admin-1',
    });

    expect(out).toEqual({ revisionNumber: 3, revisionId: 'rev-new' });
    // Only the re-run row is created — there is no delivered header row to snapshot, so the rev-0
    // baseline step short-circuits.
    expect(revCreate).toHaveBeenCalledTimes(1);
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reportId: 'rep1',
          revisionNumber: 3,
          status: 'queued',
          settingsSnapshot: settings,
          instructions: 'warmer tone',
          authoredBy: 'admin',
          createdBy: 'admin-1',
        }),
      })
    );
  });

  it('starts at revision 1 when there is no prior revision, and nulls an empty note', async () => {
    revFindUnique.mockResolvedValue(null); // no rev-0 baseline
    headerFindUnique.mockResolvedValue(null); // nothing delivered to snapshot
    revFindFirst.mockResolvedValue(null);

    const out = await enqueueRespondentReportRevision({
      sessionId: 'sess-1',
      settings,
      instructions: '   ',
      adminId: 'admin-1',
    });

    expect(out.revisionNumber).toBe(1);
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ instructions: null }) })
    );
  });

  it('captures the delivered report as the Original (revision 0) on the first re-run', async () => {
    revFindUnique.mockResolvedValueOnce(null); // no rev 0 yet
    headerFindUnique.mockResolvedValueOnce({
      content,
      formatted: true,
      completionPct: 80,
      mode: 'narrative',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // After the baseline (0) is created, the "last" revision is 0 → the re-run becomes #1.
    revFindFirst.mockResolvedValue({ revisionNumber: 0 });

    await enqueueRespondentReportRevision({ sessionId: 'sess-1', settings, adminId: 'admin-1' });

    // Two creates: the Original baseline (rev 0, ready, AI-authored) then the queued re-run (rev 1).
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revisionNumber: 0,
          status: 'ready',
          content,
          authoredBy: 'ai',
        }),
      })
    );
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revisionNumber: 1 }) })
    );
  });
});

describe('promoteRespondentReportRevision', () => {
  it('captures the Original baseline before overwriting, when the enqueue could not', async () => {
    // Regression: a re-run queued while the ORIGINAL was still generating finds `content: null`, so
    // enqueue snapshots nothing. The worker then fills the original in. Promoting the re-run must
    // capture that original as revision 0 first, or it is lost and "Revert to original" never appears.
    headerFindUnique
      .mockResolvedValueOnce({ id: 'rep1' }) // promote's own header lookup
      .mockResolvedValueOnce({
        // the baseline helper's lookup — the original has landed by now
        content,
        formatted: true,
        completionPct: 80,
        mode: 'narrative',
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    revFindUnique
      .mockResolvedValueOnce({
        id: 'rev-1',
        status: 'ready',
        content: { summary: 'rerun' },
        formatted: true,
        completionPct: 80,
        settingsSnapshot: settings,
      }) // the revision being promoted
      .mockResolvedValueOnce(null); // no rev-0 baseline exists yet
    headerUpdate.mockResolvedValue({});

    await promoteRespondentReportRevision({ sessionId: 'sess-1', revisionNumber: 1 });

    // The pre-promote delivered content was snapshotted as revision 0 ("Original").
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revisionNumber: 0, status: 'ready', content }),
      })
    );
    // …and the promote still landed.
    expect(headerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: { summary: 'rerun' },
          deliveredRevisionId: 'rev-1',
        }),
      })
    );
  });

  it('copies a `ready` revision onto the delivered report and records deliveredRevisionId', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue({
      id: 'rev-9',
      status: 'ready',
      content,
      formatted: true,
      completionPct: 80,
      settingsSnapshot: settings,
    });
    headerUpdate.mockResolvedValue({});

    const out = await promoteRespondentReportRevision({ sessionId: 'sess-1', revisionNumber: 9 });

    expect(out).toEqual({ promoted: true });
    expect(headerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rep1' },
        data: expect.objectContaining({
          status: 'ready',
          content,
          formatted: true,
          completionPct: 80,
          mode: 'narrative',
          deliveredRevisionId: 'rev-9',
          notifyEmail: null,
        }),
      })
    );
  });

  it('is a no-op when the revision is not ready', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue({
      id: 'rev-9',
      status: 'processing',
      content: null,
      formatted: false,
      completionPct: null,
      settingsSnapshot: settings,
    });

    const out = await promoteRespondentReportRevision({ sessionId: 'sess-1', revisionNumber: 9 });
    expect(out).toEqual({ promoted: false });
    expect(headerUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the session has no report header', async () => {
    headerFindUnique.mockResolvedValue(null);
    const out = await promoteRespondentReportRevision({ sessionId: 'sess-1', revisionNumber: 1 });
    expect(out).toEqual({ promoted: false });
    expect(revFindUnique).not.toHaveBeenCalled();
    expect(headerUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the revision number does not exist (header present)', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue(null);
    const out = await promoteRespondentReportRevision({ sessionId: 'sess-1', revisionNumber: 99 });
    expect(out).toEqual({ promoted: false });
    expect(headerUpdate).not.toHaveBeenCalled();
  });
});

describe('getRespondentReportRevisionsView', () => {
  it('returns empty when the session has no report header', async () => {
    headerFindUnique.mockResolvedValue(null);
    const view = await getRespondentReportRevisionsView('sess-1');
    expect(view).toEqual({ delivered: null, revisions: [] });
    expect(revFindMany).not.toHaveBeenCalled();
  });

  it('marks the promoted revision as delivered and surfaces the header status', async () => {
    headerFindUnique.mockResolvedValue({
      id: 'rep1',
      status: 'ready',
      content,
      generatedAt: new Date('2026-07-16T00:00:00Z'),
      deliveredRevisionId: 'rev-b',
    });
    revFindMany.mockResolvedValue([
      {
        id: 'rev-b',
        revisionNumber: 2,
        status: 'ready',
        authoredBy: 'admin',
        instructions: 'v2',
        settingsSnapshot: settings,
        completionPct: 100,
        costUsd: 0.02,
        error: null,
        generatedAt: new Date('2026-07-16T00:00:00Z'),
        createdAt: new Date('2026-07-16T00:00:00Z'),
      },
      {
        id: 'rev-a',
        revisionNumber: 1,
        status: 'ready',
        authoredBy: 'admin',
        instructions: null,
        settingsSnapshot: settings,
        completionPct: 100,
        costUsd: 0.01,
        error: null,
        generatedAt: new Date('2026-07-16T00:00:00Z'),
        createdAt: new Date('2026-07-15T00:00:00Z'),
      },
    ]);

    const view = await getRespondentReportRevisionsView('sess-1');
    expect(view.delivered).toMatchObject({
      status: 'ready',
      hasContent: true,
      deliveredRevisionId: 'rev-b',
    });
    expect(view.revisions.map((r) => [r.revisionNumber, r.delivered])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(view.revisions[0].mode).toBe('narrative');
  });

  it('reports hasContent:false for an inert header with no delivered content yet', async () => {
    headerFindUnique.mockResolvedValue({
      id: 'rep1',
      status: 'ready',
      content: null,
      generatedAt: null,
      deliveredRevisionId: null,
    });
    revFindMany.mockResolvedValue([]);

    const view = await getRespondentReportRevisionsView('sess-1');
    expect(view.delivered).toMatchObject({
      status: 'ready',
      hasContent: false,
      generatedAt: null,
      deliveredRevisionId: null,
    });
    expect(view.revisions).toEqual([]);
  });
});

describe('getRespondentReportRevisionDetail', () => {
  it('returns validated content for an existing revision', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue({
      revisionNumber: 3,
      status: 'ready',
      instructions: 'note',
      settingsSnapshot: settings,
      content,
      formatted: true,
      completionPct: 90,
      error: null,
    });

    const detail = await getRespondentReportRevisionDetail('sess-1', 3);
    expect(detail).toMatchObject({
      revisionNumber: 3,
      status: 'ready',
      mode: 'narrative',
      formatted: true,
      completionPct: 90,
    });
    expect(detail?.content).toMatchObject({ summary: 'S' });
  });

  it('returns null when the session has no header', async () => {
    headerFindUnique.mockResolvedValue(null);
    const detail = await getRespondentReportRevisionDetail('sess-1', 3);
    expect(detail).toBeNull();
    expect(revFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when the header exists but the revision number is unknown', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue(null);
    const detail = await getRespondentReportRevisionDetail('sess-1', 42);
    expect(detail).toBeNull();
  });

  it('returns null content (without throwing) for a not-yet-generated revision', async () => {
    headerFindUnique.mockResolvedValue({ id: 'rep1' });
    revFindUnique.mockResolvedValue({
      revisionNumber: 4,
      status: 'processing',
      instructions: null,
      settingsSnapshot: settings,
      content: null,
      formatted: false,
      completionPct: null,
      error: null,
    });

    const detail = await getRespondentReportRevisionDetail('sess-1', 4);
    expect(detail).toMatchObject({ revisionNumber: 4, status: 'processing', content: null });
  });
});
