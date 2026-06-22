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

const params = { roundId: 'r1', roundName: 'Q1', versionId: 'v1', dataset };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildCohortReportView', () => {
  it('returns exists:false with the dataset when no report has been generated', async () => {
    findUniqueReport.mockResolvedValue(null);
    const view = await buildCohortReportView(params);
    expect(view.exists).toBe(false);
    expect(view.status).toBeNull();
    expect(view.content).toBeNull();
    expect(view.dataset.totalSessions).toBe(8);
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
