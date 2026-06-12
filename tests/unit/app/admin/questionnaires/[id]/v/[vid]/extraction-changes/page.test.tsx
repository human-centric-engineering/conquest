/**
 * Extraction-changes tab page (`/admin/questionnaires/[id]/v/[vid]/extraction-changes`) tests.
 *
 * The page is an async Server Component that:
 *  - gates on isQuestionnairesEnabled()
 *  - reads `id` and `vid` from params
 *  - fetches the version's extraction changes via serverFetch
 *  - renders ExtractionChangesTable when the fetch succeeds
 *  - renders a fallback paragraph when the fetch fails or returns no data
 *  - degrades gracefully (without throwing) when serverFetch rejects or !ok
 *
 * The heavy ExtractionChangesTable child is stubbed to an identifiable marker
 * that exposes the props it receives as data-attributes so tests can assert on
 * what the page computed -- not what the mock returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ExtractionChangeListResponse } from '@/lib/app/questionnaire/extraction-review';

// --- Navigation mock ----------------------------------------------------------

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
}));

// --- Feature-flag mock --------------------------------------------------------

const flagMock = vi.hoisted(() => ({
  isQuestionnairesEnabled: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// --- server-fetch mock --------------------------------------------------------

const apiMock = vi.hoisted(() => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));
vi.mock('@/lib/api/server-fetch', () => apiMock);

// --- logger mock --------------------------------------------------------------

const loggerMock = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

// --- Stub ExtractionChangesTable ----------------------------------------------

vi.mock('@/components/admin/questionnaires/extraction-changes-table', () => ({
  ExtractionChangesTable: (props: {
    questionnaireId: string;
    versionId: string;
    changes: unknown[];
    counts: { applied: number; reverted: number };
  }) => (
    <div
      data-testid="extraction-changes-table"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-change-count={String(props.changes.length)}
      data-applied={String(props.counts.applied)}
      data-reverted={String(props.counts.reverted)}
    />
  ),
}));

// --- Factories ----------------------------------------------------------------

function makeChangesResponse(
  over: Partial<ExtractionChangeListResponse> = {}
): ExtractionChangeListResponse {
  return {
    changes: [],
    counts: { applied: 0, reverted: 0 },
    ...over,
  };
}

// --- Page import --------------------------------------------------------------

import ExtractionChangesTab from '@/app/admin/questionnaires/[id]/v/[vid]/extraction-changes/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return ExtractionChangesTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// --- Setup --------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({
    success: true,
    data: makeChangesResponse(),
  });
});

// --- Tests --------------------------------------------------------------------

describe('ExtractionChangesTab', () => {
  describe('feature-flag gating', () => {
    it('calls notFound when the questionnaires feature flag is off', async () => {
      // Arrange
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('happy path -- ExtractionChangesTable rendering', () => {
    it('renders the ExtractionChangesTable with the correct questionnaireId and versionId', async () => {
      // Act
      render(await renderPage({ id: 'qn-42', vid: 'ver-99' }));

      // Assert: IDs originate from params, not the mock
      const table = screen.getByTestId('extraction-changes-table');
      expect(table).toHaveAttribute('data-qid', 'qn-42');
      expect(table).toHaveAttribute('data-vid', 'ver-99');
    });

    it('passes the changes array length to the table', async () => {
      // Arrange: two change records
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: makeChangesResponse({
          changes: [
            {
              id: 'ch-1',
              changeType: 'augment_question',
              targetEntityType: 'question',
              sourceQuote: null,
              beforeJson: null,
              afterJson: { key: 'q1' },
              rationale: null,
              confidence: null,
              status: 'applied',
              revertedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              resolvedTargetLabel: 'q1',
              revertable: true,
              revertBlockedReason: null,
              revertSummary: 'Revert augmentation on q1',
            },
            {
              id: 'ch-2',
              changeType: 'rewrite_prompt',
              targetEntityType: 'question',
              sourceQuote: null,
              beforeJson: {},
              afterJson: {},
              rationale: null,
              confidence: 0.9,
              status: 'applied',
              revertedAt: null,
              createdAt: '2026-01-02T00:00:00.000Z',
              resolvedTargetLabel: 'q2',
              revertable: false,
              revertBlockedReason: 'graph_drift',
              revertSummary: null,
            },
          ],
          counts: { applied: 2, reverted: 0 },
        }),
      });

      // Act
      render(await renderPage());

      // Assert: the page passed the full changes array to the child
      const table = screen.getByTestId('extraction-changes-table');
      expect(table).toHaveAttribute('data-change-count', '2');
      expect(table).toHaveAttribute('data-applied', '2');
      expect(table).toHaveAttribute('data-reverted', '0');
    });

    it('passes an empty changes array and zero counts when the response is empty', async () => {
      // Arrange: default setup returns empty changes
      // Act
      render(await renderPage());

      // Assert: table renders with zero counts
      const table = screen.getByTestId('extraction-changes-table');
      expect(table).toHaveAttribute('data-change-count', '0');
      expect(table).toHaveAttribute('data-applied', '0');
    });
  });

  describe('graceful degradation on failed fetch', () => {
    it('renders the fallback paragraph and not the table when serverFetch returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValue({ ok: false });

      // Act
      render(await renderPage());

      // Assert: the !res.ok path returns null -- page shows the fallback
      expect(screen.queryByTestId('extraction-changes-table')).not.toBeInTheDocument();
      expect(
        screen.getByText(/Could not load this version.*extraction changes/i)
      ).toBeInTheDocument();
    });

    it('does not call parseApiResponse when serverFetch returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValue({ ok: false });

      // Act
      render(await renderPage());

      // Assert: the !res.ok guard returns early
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('renders the fallback paragraph and not the table when parseApiResponse returns success:false', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: false, error: {} });

      // Act
      render(await renderPage());

      // Assert
      expect(screen.queryByTestId('extraction-changes-table')).not.toBeInTheDocument();
      expect(
        screen.getByText(/Could not load this version.*extraction changes/i)
      ).toBeInTheDocument();
    });

    it('renders the fallback paragraph, not the table, and logs when serverFetch throws', async () => {
      // Arrange
      apiMock.serverFetch.mockRejectedValue(new Error('network down'));

      // Act
      render(await renderPage());

      // Assert: catch path -> null -> fallback rendered
      expect(screen.queryByTestId('extraction-changes-table')).not.toBeInTheDocument();
      expect(
        screen.getByText(/Could not load this version.*extraction changes/i)
      ).toBeInTheDocument();
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'changes tab: fetch failed',
        expect.any(Error)
      );
    });
  });

  describe('introductory copy', () => {
    it('always renders the introductory paragraph text', async () => {
      // Act
      render(await renderPage());

      // Assert: the description is always present regardless of data state
      expect(screen.getByText(/every editorial decision the extractor made/i)).toBeInTheDocument();
    });
  });
});
