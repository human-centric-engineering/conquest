/**
 * Evaluations tab page (`/admin/questionnaires/[id]/v/[vid]/evaluations`) tests.
 *
 * The page is an async Server Component that:
 *  - fetches the questionnaire detail via getQuestionnaireDetailCached
 *  - calls notFound() when the detail is null or vid is not in the versions list
 *  - fetches evaluation runs via serverFetch (with a limit=50 cap)
 *  - renders EvaluationRunsTable with the resolved props (canRun always true)
 *  - degrades gracefully on fetch failures (network error, !ok, success:false)
 *
 * Fetching is mocked at the `server-fetch` and `workspace-data` boundaries.
 * EvaluationRunsTable is stubbed to an identifiable marker so we assert the page's own logic,
 * not the child's internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  EvaluationRunListItem,
} from '@/lib/app/questionnaire/views';

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

// ─── workspace-data mock ──────────────────────────────────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
}));
vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

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

// ─── Stub EvaluationRunsTable to an identifiable marker ──────────────────────

vi.mock('@/components/admin/questionnaires/evaluation-runs-table', () => ({
  EvaluationRunsTable: (props: {
    questionnaireId: string;
    versionId: string;
    versionNumber: number;
    runs: EvaluationRunListItem[];
    canRun: boolean;
  }) => (
    <div
      data-testid="evaluation-runs-table"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-version-number={String(props.versionNumber)}
      data-run-count={String(props.runs.length)}
      data-can-run={String(props.canRun)}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 3,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    sectionCount: 2,
    questionCount: 5,
    dataSlotCount: 0,
    archivedAt: null,
    changeCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function makeDetail(over: Partial<QuestionnaireDetail> = {}): QuestionnaireDetail {
  return {
    id: 'qn-1',
    title: 'Northwind Onboarding',
    status: 'draft',
    demoClient: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

function makeRun(over: Partial<EvaluationRunListItem> = {}): EvaluationRunListItem {
  return {
    id: 'run-1',
    status: 'completed',
    dimensionsRequested: 7,
    dimensionsRun: 7,
    dimensionsFailed: 0,
    totalFindings: 4,
    dimensionSummary: [],
    triggeredByUserId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import EvaluationsTab from '@/app/admin/questionnaires/[id]/v/[vid]/evaluations/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return EvaluationsTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({ success: true, data: [] });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationsTab', () => {
  describe('data gating', () => {
    it('calls notFound when the questionnaire detail is null', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when vid is not in the versions list', async () => {
      // Arrange — detail has ver-other, page requests ver-1
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-other' })] })
      );

      // Act + Assert
      await expect(renderPage({ vid: 'ver-1' })).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('EvaluationRunsTable rendering', () => {
    it('renders the table with the correct questionnaire and version IDs', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ id: 'qn-42', versions: [makeVersion({ id: 'ver-99' })] })
      );

      // Act
      render(await renderPage({ id: 'qn-42', vid: 'ver-99' }));

      // Assert — the page wired up the IDs from params/detail, not from the mock directly
      const table = screen.getByTestId('evaluation-runs-table');
      expect(table).toHaveAttribute('data-qid', 'qn-42');
      expect(table).toHaveAttribute('data-vid', 'ver-99');
    });

    it('passes versionNumber from the matching version summary', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', versionNumber: 5 })] })
      );

      // Act
      render(await renderPage());

      // Assert — versionNumber flows from the selected version, not hardcoded
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute(
        'data-version-number',
        '5'
      );
    });

    it('passes the fetched runs to the table', async () => {
      // Arrange — two runs returned by the API
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeRun({ id: 'run-1' }), makeRun({ id: 'run-2' })],
      });

      // Act
      render(await renderPage());

      // Assert — the page forwards all runs (count reflects what the fetch returned)
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute('data-run-count', '2');
    });

    it('passes canRun=true (design evaluation is always available)', async () => {
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute('data-can-run', 'true');
    });

    it('fetches runs with limit=50 applied to the URL', async () => {
      // Arrange — captured via mock call inspection
      render(await renderPage({ id: 'qn-1', vid: 'ver-1' }));

      // Assert — page appended ?limit=50, not the default 20
      const fetchedUrl: string = apiMock.serverFetch.mock.calls[0][0];
      expect(fetchedUrl).toContain('limit=50');
    });
  });

  describe('graceful degradation on failed runs fetch', () => {
    it('renders with empty runs when serverFetch responds !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValueOnce({ ok: false });

      // Act
      render(await renderPage());

      // Assert — page degrades to empty list; parseApiResponse must not run
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute('data-run-count', '0');
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('renders with empty runs when parseApiResponse returns success:false', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValueOnce({ success: false, error: {} });

      // Act
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute('data-run-count', '0');
    });

    it('logs and renders empty runs when serverFetch throws (catch path)', async () => {
      // Arrange
      apiMock.serverFetch.mockRejectedValueOnce(new Error('network down'));

      // Act
      render(await renderPage());

      // Assert — page falls back gracefully and logs the error
      expect(screen.getByTestId('evaluation-runs-table')).toHaveAttribute('data-run-count', '0');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'evaluations tab: runs fetch failed',
        expect.any(Error)
      );
    });
  });

  describe('page description text', () => {
    it('renders the seven-judges description', async () => {
      // Arrange — default setup is sufficient
      render(await renderPage());

      // Assert — static copy is present; verifies the component rendered its body
      expect(screen.getByText(/seven design-time judges/i)).toBeInTheDocument();
    });
  });
});
