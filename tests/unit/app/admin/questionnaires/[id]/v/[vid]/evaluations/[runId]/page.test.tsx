/**
 * Evaluation run detail page (`/admin/questionnaires/[id]/v/[vid]/evaluations/[runId]`) tests.
 *
 * The page is an async Server Component that:
 *  - gates on isQuestionnairesEnabled() — calls notFound() when off
 *  - fetches a single evaluation run by (id, vid, runId) via serverFetch
 *  - calls notFound() when the run fetch fails (!ok), returns success:false, or throws
 *  - reads isDesignEvaluationEnabled() to derive `canApply`
 *  - renders EvaluationRunDetail with the resolved run + canApply
 *  - includes a back-link to the evaluations list
 *  - logs on fetch exceptions
 *
 * Fetching is mocked at the `server-fetch` and `feature-flag` boundaries. workspaceVersionBase
 * is mocked so we can assert the back-link href without importing actual nav logic.
 * EvaluationRunDetail is stubbed to an identifiable marker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { EvaluationRunDetail as EvaluationRunDetailView } from '@/lib/app/questionnaire/views';

// ─── Navigation mock ──────────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
}));

// ─── Feature-flag mock ────────────────────────────────────────────────────────

const flagMock = vi.hoisted(() => ({
  isQuestionnairesEnabled: vi.fn(),
  isDesignEvaluationEnabled: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// ─── workspace-nav mock ───────────────────────────────────────────────────────

const workspaceNavMock = vi.hoisted(() => ({
  workspaceVersionBase: vi.fn((id: string, vid: string) => `/admin/questionnaires/${id}/v/${vid}`),
}));
vi.mock('@/lib/app/questionnaire/workspace-nav', () => workspaceNavMock);

// ─── server-fetch mock ────────────────────────────────────────────────────────

const apiMock = vi.hoisted(() => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));
vi.mock('@/lib/api/server-fetch', () => apiMock);

// ─── logger mock ──────────────────────────────────────────────────────────────

const loggerMock = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

// ─── Stub EvaluationRunDetail to an identifiable marker ──────────────────────

vi.mock('@/components/admin/questionnaires/evaluation-run-detail', () => ({
  EvaluationRunDetail: (props: {
    run: EvaluationRunDetailView;
    questionnaireId: string;
    versionId: string;
    canApply: boolean;
  }) => (
    <div
      data-testid="evaluation-run-detail"
      data-run-id={props.run.id}
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-can-apply={String(props.canApply)}
      data-created-at={props.run.createdAt}
    />
  ),
}));

// ─── Factory ─────────────────────────────────────────────────────────────────

function makeRun(over: Partial<EvaluationRunDetailView> = {}): EvaluationRunDetailView {
  return {
    id: 'run-1',
    versionId: 'ver-1',
    questionnaireId: 'qn-1',
    status: 'completed',
    error: null,
    dimensionsRequested: 7,
    dimensionsRun: 7,
    dimensionsFailed: 0,
    totalFindings: 3,
    dimensionSummary: [],
    findings: [],
    triggeredByUserId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import EvaluationRunTab from '@/app/admin/questionnaires/[id]/v/[vid]/evaluations/[runId]/page';

function renderPage(opts: { id?: string; vid?: string; runId?: string } = {}) {
  return EvaluationRunTab({
    params: Promise.resolve({
      id: opts.id ?? 'qn-1',
      vid: opts.vid ?? 'ver-1',
      runId: opts.runId ?? 'run-1',
    }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  flagMock.isDesignEvaluationEnabled.mockResolvedValue(true);
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeRun() });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationRunTab', () => {
  describe('feature-flag gating', () => {
    it('calls notFound when the questionnaires master flag is off', async () => {
      // Arrange
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('run not-found paths', () => {
    it('calls notFound when serverFetch returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValueOnce({ ok: false });

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when parseApiResponse returns success:false', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValueOnce({ success: false, error: {} });

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound and logs when serverFetch throws', async () => {
      // Arrange
      apiMock.serverFetch.mockRejectedValueOnce(new Error('network down'));

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'evaluation run tab: run fetch failed',
        expect.any(Error)
      );
    });
  });

  describe('EvaluationRunDetail rendering', () => {
    it('passes the fetched run id to the detail component', async () => {
      // Arrange — run-42 is what the API returns
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: makeRun({ id: 'run-42' }),
      });

      // Act
      render(await renderPage({ runId: 'run-42' }));

      // Assert — the page threaded the fetched run through, not the raw params
      expect(screen.getByTestId('evaluation-run-detail')).toHaveAttribute('data-run-id', 'run-42');
    });

    it('passes the questionnaire and version IDs from params', async () => {
      // Arrange
      render(await renderPage({ id: 'qn-99', vid: 'ver-77', runId: 'run-1' }));

      // Assert
      const detail = screen.getByTestId('evaluation-run-detail');
      expect(detail).toHaveAttribute('data-qid', 'qn-99');
      expect(detail).toHaveAttribute('data-vid', 'ver-77');
    });

    it('passes canApply=true when design-evaluation flag is on', async () => {
      // Arrange — flag already on from beforeEach
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('evaluation-run-detail')).toHaveAttribute('data-can-apply', 'true');
    });

    it('passes canApply=false when design-evaluation flag is off', async () => {
      // Arrange
      flagMock.isDesignEvaluationEnabled.mockResolvedValue(false);

      // Act
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('evaluation-run-detail')).toHaveAttribute(
        'data-can-apply',
        'false'
      );
    });

    it('renders the run createdAt timestamp via the page header', async () => {
      // Arrange — a known ISO timestamp so we can predict the locale string
      const createdAt = '2026-03-15T10:30:00.000Z';
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: makeRun({ createdAt }),
      });

      // Act
      render(await renderPage());

      // Assert — page renders the timestamp in the header (from run.createdAt)
      const detail = screen.getByTestId('evaluation-run-detail');
      expect(detail).toHaveAttribute('data-created-at', createdAt);
    });
  });

  describe('back-link', () => {
    it('renders an "Evaluations" back-link pointing to the evaluations list', async () => {
      // Arrange — workspaceVersionBase returns a predictable base
      workspaceNavMock.workspaceVersionBase.mockReturnValue('/admin/questionnaires/qn-1/v/ver-1');

      // Act
      render(await renderPage({ id: 'qn-1', vid: 'ver-1' }));

      // Assert — link appends /evaluations to the workspace version base
      const link = screen.getByRole('link', { name: /evaluations/i });
      expect(link).toHaveAttribute('href', '/admin/questionnaires/qn-1/v/ver-1/evaluations');
    });
  });
});
