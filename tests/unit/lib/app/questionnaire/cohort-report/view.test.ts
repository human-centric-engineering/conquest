/**
 * Unit test: cohort-report read view (F14.3/F14.6).
 *
 * Mocks the report header read (and passes a pre-built dataset) and asserts the view shape:
 * `exists: false` before any report, and the working-head revision + publish pointer once present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueReport = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: { appCohortReport: { findUnique: (...a: unknown[]) => findUniqueReport(...a) } },
}));

import { buildCohortReportView } from '@/lib/app/questionnaire/cohort-report/view';
import { roundScope, versionScope } from '@/lib/app/questionnaire/cohort-report/scope';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1',
  versionId: 'v1',
  totalSessions: 8,
  completedSessions: 7,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [],
  segmentation: [],
};

const params = { scope: roundScope('r1', 'v1', 'Q1'), dataset };

beforeEach(() => {
  vi.clearAllMocks();
});

const versionDataset: CohortDataset = {
  roundId: null,
  roundName: 'Version label',
  versionId: 'v1',
  totalSessions: 10,
  completedSessions: 9,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [],
  segmentation: [],
};

describe('buildCohortReportView', () => {
  it('returns exists:false with the dataset when no report has been generated', async () => {
    findUniqueReport.mockResolvedValue(null);
    const view = await buildCohortReportView(params);
    expect(view.exists).toBe(false);
    expect(view.status).toBeNull();
    expect(view.content).toBeNull();
    expect(view.dataset.totalSessions).toBe(8);
  });

  it('returns exists:true with null head fields when report header exists but has no revisions (generation in progress)', async () => {
    findUniqueReport.mockResolvedValue({
      title: 'Q1 — cohort report',
      status: 'processing',
      publishStatus: 'draft',
      publishedRevisionNumber: null,
      costUsd: null,
      error: null,
      generatedAt: null,
      _count: { revisions: 0 },
      // revisions:[0] ?? null → null, so head is null
      revisions: [],
    });

    const view = await buildCohortReportView(params);

    // Row exists (generation started) but no revision has been persisted yet.
    expect(view.exists).toBe(true);
    expect(view.status).toBe('processing');
    // The head is null, so these three must all be null.
    expect(view.revisionNumber).toBeNull();
    expect(view.authoredBy).toBeNull();
    expect(view.content).toBeNull();
    expect(view.revisionCount).toBe(0);
  });

  it('maps the header + working-head revision + publish pointer when present', async () => {
    findUniqueReport.mockResolvedValue({
      title: 'Q1 — cohort report',
      status: 'ready',
      publishStatus: 'published',
      publishedRevisionNumber: 2,
      costUsd: 0.05,
      error: null,
      generatedAt: new Date('2026-06-22T00:00:00.000Z'),
      _count: { revisions: 3 },
      revisions: [
        {
          revisionNumber: 3,
          authoredBy: 'admin',
          content: {
            summary: 'Edited',
            sections: [],
            charts: [],
            recommendations: [],
            actions: [],
          },
        },
      ],
    });

    const view = await buildCohortReportView(params);

    expect(view.exists).toBe(true);
    expect(view.status).toBe('ready');
    expect(view.publishStatus).toBe('published');
    expect(view.publishedRevisionNumber).toBe(2);
    expect(view.revisionNumber).toBe(3);
    expect(view.revisionCount).toBe(3);
    expect(view.authoredBy).toBe('admin');
    expect(view.content?.summary).toBe('Edited');
    expect(view.generatedAt).toBe('2026-06-22T00:00:00.000Z');
  });
});

describe('buildCohortReportView — versionScope', () => {
  it('returns exists:false, scopeKind:version, roundId:null when no report row exists', async () => {
    findUniqueReport.mockResolvedValue(null);

    const view = await buildCohortReportView({
      scope: versionScope('v1', 'Version label'),
      dataset: versionDataset,
    });

    // The view must be looked up via { versionOwnerId: 'v1' } — the version scope key.
    expect(findUniqueReport).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionOwnerId: 'v1' } })
    );
    expect(view.exists).toBe(false);
    expect(view.scopeKind).toBe('version');
    expect(view.roundId).toBeNull();
    expect(view.status).toBeNull();
    expect(view.content).toBeNull();
  });

  it('maps the header + head revision for a version-scope report row', async () => {
    findUniqueReport.mockResolvedValue({
      title: 'Version-wide — cohort report',
      status: 'ready',
      publishStatus: 'draft',
      publishedRevisionNumber: null,
      costUsd: 0.12,
      error: null,
      generatedAt: new Date('2026-06-25T00:00:00.000Z'),
      _count: { revisions: 1 },
      revisions: [
        {
          revisionNumber: 1,
          authoredBy: 'ai',
          content: {
            summary: 'Version-wide summary.',
            sections: [],
            charts: [],
            recommendations: [],
            actions: [],
          },
        },
      ],
    });

    const view = await buildCohortReportView({
      scope: versionScope('v1', 'Version label'),
      dataset: versionDataset,
    });

    // The lookup must use the version owner key, not roundId.
    expect(findUniqueReport).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionOwnerId: 'v1' } })
    );
    expect(view.exists).toBe(true);
    expect(view.scopeKind).toBe('version');
    // Version-wide reports have no owning round.
    expect(view.roundId).toBeNull();
    expect(view.status).toBe('ready');
    expect(view.revisionNumber).toBe(1);
    expect(view.revisionCount).toBe(1);
    expect(view.content?.summary).toBe('Version-wide summary.');
  });
});
