/**
 * CohortReportPanel tests (F14.3 read view).
 *
 * apiClient is mocked. Asserts the no-versions empty state, that a loaded view renders the report
 * body (summary + section + recommendations + actions) and resolves a referenced chart, and that
 * "Generate" vs "Regenerate" reflects whether a report exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
  APIClientError: class extends Error {},
}));

import { apiClient } from '@/lib/api/client';
import { CohortReportPanel } from '@/components/admin/cohorts/cohort-report-panel';
import type { ReportApi } from '@/components/admin/cohorts/report-api';
import type { CohortReportView } from '@/lib/app/questionnaire/cohort-report';

type Mock = ReturnType<typeof vi.fn>;

/** Minimal ReportApi for tests — only viewUrl matters for the load path. */
function fakeApi(overrides: Partial<ReportApi> = {}): ReportApi {
  return {
    viewUrl: '/api/v1/app/rounds/r1/cohort-report?versionId=v1',
    datasetUrl: '/api/v1/app/rounds/r1/cohort-report/dataset?versionId=v1',
    generateStreamUrl: '/api/v1/app/rounds/r1/cohort-report/generate/stream',
    revisionsUrl: '/api/v1/app/rounds/r1/cohort-report/revisions',
    publishUrl: '/api/v1/app/rounds/r1/cohort-report/publish',
    pdfUrl: '/api/v1/app/rounds/r1/cohort-report/pdf?versionId=v1',
    patchUrl: '/api/v1/app/rounds/r1/cohort-report',
    body: { versionId: 'v1' },
    ...overrides,
  };
}

function view(overrides: Partial<CohortReportView> = {}): CohortReportView {
  return {
    scopeKind: 'round',
    roundId: 'r1',
    stepId: null,
    versionId: 'v1',
    exists: true,
    title: 'Q1 — cohort report',
    status: 'ready',
    publishStatus: 'draft',
    publishedRevisionNumber: null,
    costUsd: 0.02,
    error: null,
    generatedAt: '2026-06-22T00:00:00.000Z',
    revisionNumber: 1,
    revisionCount: 1,
    authoredBy: 'ai',
    content: {
      summary: 'Overall engagement is strong.',
      sections: [{ heading: 'Engagement', body: 'Mean 4.1.', chartIds: ['c1'] }],
      charts: [{ id: 'c1', title: 'Sizes by team', kind: 'segment_sizes', dimensionKey: 'team' }],
      recommendations: ['Sustain momentum'],
      actions: ['Share results'],
    },
    dataset: {
      roundId: 'r1',
      roundName: 'Q1',
      versionId: 'v1',
      totalSessions: 8,
      completedSessions: 7,
      kThreshold: 5,
      suppressed: false,
      anonymous: false,
      overall: [],
      segmentation: [
        {
          dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
          segments: [
            {
              value: 'Eng',
              label: 'Eng',
              totalSessions: 5,
              completedSessions: 5,
              suppressed: false,
              questions: [],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CohortReportPanel', () => {
  it('shows an empty state when the round has no bundled versions', () => {
    render(<CohortReportPanel api={fakeApi()} versions={[]} />);
    expect(screen.getByText(/attach a questionnaire/i)).toBeInTheDocument();
  });

  it('renders the report body when a view loads', async () => {
    (apiClient.get as Mock).mockResolvedValue(view());
    render(
      <CohortReportPanel
        api={fakeApi()}
        versions={[{ versionId: 'v1', title: 'Pulse' }]}
        versionId="v1"
      />
    );

    await waitFor(() => expect(screen.getByTestId('cohort-report-body')).toBeInTheDocument());
    expect(screen.getByText('Overall engagement is strong.')).toBeInTheDocument();
    expect(screen.getByText('Engagement')).toBeInTheDocument();
    expect(screen.getByText('Sustain momentum')).toBeInTheDocument();
    expect(screen.getByText('Share results')).toBeInTheDocument();
    // The referenced chart resolves and renders its title.
    expect(screen.getByText('Sizes by team')).toBeInTheDocument();
    // An existing report offers "Regenerate".
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('offers "Generate report" when none exists yet', async () => {
    (apiClient.get as Mock).mockResolvedValue(view({ exists: false, content: null, status: null }));
    render(
      <CohortReportPanel
        api={fakeApi()}
        versions={[{ versionId: 'v1', title: 'Pulse' }]}
        versionId="v1"
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /generate report/i })).toBeInTheDocument()
    );
  });
});
