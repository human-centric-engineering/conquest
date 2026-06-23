/**
 * Unit test: cohort-report persistence (F14.3/F14.6).
 *
 * Asserts the version-control logic: append computes the next revision number + marks the report
 * ready, restore appends a copy of a past revision, and publish validates the revision exists before
 * pinning it (and unpublish clears the pointer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const revFindFirst = vi.fn();
const revFindUnique = vi.fn();
const revCreate = vi.fn();
const reportUpdate = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appCohortReportRevision: {
      findFirst: (...a: unknown[]) => revFindFirst(...a),
      findUnique: (...a: unknown[]) => revFindUnique(...a),
      create: (...a: unknown[]) => revCreate(...a),
    },
    appCohortReport: { update: (...a: unknown[]) => reportUpdate(...a) },
    // $transaction runs the callback with the same mocked client.
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        appCohortReportRevision: {
          findFirst: (...a: unknown[]) => revFindFirst(...a),
          create: (...a: unknown[]) => revCreate(...a),
        },
        appCohortReport: { update: (...a: unknown[]) => reportUpdate(...a) },
      }),
  },
}));

import {
  appendCohortReportRevision,
  restoreCohortReportRevision,
  setCohortReportPublish,
} from '@/lib/app/questionnaire/cohort-report/persist';

const content = { summary: 'S', sections: [], charts: [], recommendations: [], actions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  revCreate.mockResolvedValue({});
  reportUpdate.mockResolvedValue({});
});

describe('appendCohortReportRevision', () => {
  it('computes the next revision number and marks the report ready', async () => {
    revFindFirst.mockResolvedValue({ revisionNumber: 4 });
    const n = await appendCohortReportRevision({
      reportId: 'rep1',
      content,
      authoredBy: 'ai',
      costUsd: 0.1,
      userId: 'u1',
    });
    expect(n).toBe(5);
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revisionNumber: 5, authoredBy: 'ai' }),
      })
    );
    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ready' }) })
    );
  });

  it('starts at revision 1 when there are no prior revisions', async () => {
    revFindFirst.mockResolvedValue(null);
    const n = await appendCohortReportRevision({
      reportId: 'rep1',
      content,
      authoredBy: 'admin',
      userId: 'u1',
    });
    expect(n).toBe(1);
  });
});

describe('restoreCohortReportRevision', () => {
  it('appends the source revision content as a new admin revision', async () => {
    revFindUnique.mockResolvedValue({ content });
    revFindFirst.mockResolvedValue({ revisionNumber: 2 });
    const n = await restoreCohortReportRevision({
      reportId: 'rep1',
      sourceRevisionNumber: 1,
      userId: 'u1',
    });
    expect(n).toBe(3);
    expect(revCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ authoredBy: 'admin' }) })
    );
  });

  it('returns null when the source revision does not exist', async () => {
    revFindUnique.mockResolvedValue(null);
    expect(
      await restoreCohortReportRevision({ reportId: 'rep1', sourceRevisionNumber: 9, userId: 'u1' })
    ).toBeNull();
  });
});

describe('setCohortReportPublish', () => {
  it('pins a revision that exists', async () => {
    revFindUnique.mockResolvedValue({ revisionNumber: 2 });
    const ok = await setCohortReportPublish({ reportId: 'rep1', revisionNumber: 2 });
    expect(ok).toBe(true);
    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { publishStatus: 'published', publishedRevisionNumber: 2 },
      })
    );
  });

  it('refuses to publish a missing revision', async () => {
    revFindUnique.mockResolvedValue(null);
    expect(await setCohortReportPublish({ reportId: 'rep1', revisionNumber: 9 })).toBe(false);
    expect(reportUpdate).not.toHaveBeenCalled();
  });

  it('unpublishes (clears the pointer) without a revision check', async () => {
    const ok = await setCohortReportPublish({ reportId: 'rep1', revisionNumber: null });
    expect(ok).toBe(true);
    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { publishStatus: 'draft', publishedRevisionNumber: null },
      })
    );
  });
});
