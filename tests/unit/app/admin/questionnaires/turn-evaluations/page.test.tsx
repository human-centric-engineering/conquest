/**
 * Admin Turn Evaluations page tests.
 *
 * The page is a thin async Server Component that:
 *  - pre-fetches page 1 of turn evaluations via serverFetch / parseApiResponse
 *  - passes the fetched items + meta to TurnEvaluationsTable as initialItems / initialMeta
 *  - renders RefLookupPanel above the table
 *  - degrades gracefully (empty items, EMPTY_META) when the fetch returns !ok
 *  - degrades gracefully when parseApiResponse returns success:false
 *  - degrades gracefully when serverFetch throws (catch branch)
 *  - uses the correct API URL (/api/v1/app/turn-evaluations?page=1&limit=25)
 *
 * Heavy children (TurnEvaluationsTable, RefLookupPanel) are stubbed so we test
 * the page's own routing/data logic, not the children's internals.
 *
 * @see app/admin/questionnaires/turn-evaluations/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { TurnEvaluationListItem } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';

// ─── next/navigation mock ────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
}));

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

// ─── Stub TurnEvaluationsTable ────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/turn-evaluations-table', () => ({
  TurnEvaluationsTable: (props: {
    initialItems: TurnEvaluationListItem[];
    initialMeta: PaginationMeta;
  }) => (
    <div
      data-testid="turn-evaluations-table"
      data-item-count={String(props.initialItems.length)}
      data-total={String(props.initialMeta.total)}
    />
  ),
}));

// ─── Stub RefLookupPanel ──────────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/ref-lookup-panel', () => ({
  RefLookupPanel: () => <div data-testid="ref-lookup-panel" />,
}));

// ─── Stub parsePaginationMeta ─────────────────────────────────────────────────

vi.mock('@/lib/validations/common', () => ({
  parsePaginationMeta: (meta: unknown): PaginationMeta | null => {
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    if (
      typeof m.page === 'number' &&
      typeof m.limit === 'number' &&
      typeof m.total === 'number' &&
      typeof m.totalPages === 'number'
    ) {
      return { page: m.page, limit: m.limit, total: m.total, totalPages: m.totalPages };
    }
    return null;
  },
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeItem(over: Partial<TurnEvaluationListItem> = {}): TurnEvaluationListItem {
  return {
    id: 'eval-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    turnOrdinal: 1,
    overallScore: 82,
    effectiveness: 'Good',
    evaluatorModel: 'claude-opus-4',
    evaluatorProvider: 'anthropic',
    rubricVersion: '1.0',
    questionnaireVersionId: 'ver-1',
    questionnaireTitle: 'Annual Survey',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    flagStatus: 'none',
    commentPreview: null,
    datasetCaseId: null,
    costUsd: 0.05,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function makeMeta(over: Partial<PaginationMeta> = {}): PaginationMeta {
  return { page: 1, limit: 25, total: 1, totalPages: 1, ...over };
}

// ─── Page import ──────────────────────────────────────────────────────────────

// Import after vi.mock declarations so mocks are in place.
import TurnEvaluationsPage from '@/app/admin/questionnaires/turn-evaluations/page';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({
    success: true,
    data: [],
    meta: { page: 1, limit: 25, total: 0, totalPages: 1 },
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TurnEvaluationsPage', () => {
  describe('render', () => {
    it('renders the turn-evaluations table', async () => {
      render(await TurnEvaluationsPage());

      expect(screen.getByTestId('turn-evaluations-table')).toBeInTheDocument();
    });
  });

  describe('static content', () => {
    it('renders the page heading', async () => {
      render(await TurnEvaluationsPage());

      expect(screen.getByRole('heading', { name: 'Turn evaluations' })).toBeInTheDocument();
    });

    it('renders the RefLookupPanel', async () => {
      render(await TurnEvaluationsPage());

      expect(screen.getByTestId('ref-lookup-panel')).toBeInTheDocument();
    });

    it('renders the page description text', async () => {
      render(await TurnEvaluationsPage());

      expect(screen.getByText(/Every persisted interview-turn verdict/i)).toBeInTheDocument();
    });
  });

  describe('data fetching', () => {
    it('fetches from the correct URL with page=1&limit=25', async () => {
      await TurnEvaluationsPage();

      const fetchedUrl: string = apiMock.serverFetch.mock.calls[0][0];
      // The page must hit the turn-evaluations root with the expected pagination params
      expect(fetchedUrl).toContain('/api/v1/app/turn-evaluations');
      expect(fetchedUrl).toContain('page=1');
      expect(fetchedUrl).toContain('limit=25');
    });

    it('passes fetched items to TurnEvaluationsTable', async () => {
      const items = [makeItem({ id: 'eval-a' }), makeItem({ id: 'eval-b' })];
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: items,
        meta: makeMeta({ total: 2 }),
      });

      render(await TurnEvaluationsPage());

      // Assert the count the page computed from the fetched data — not the mock length directly
      expect(screen.getByTestId('turn-evaluations-table')).toHaveAttribute('data-item-count', '2');
    });

    it('passes pagination meta total to TurnEvaluationsTable', async () => {
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeItem()],
        meta: makeMeta({ total: 42 }),
      });

      render(await TurnEvaluationsPage());

      expect(screen.getByTestId('turn-evaluations-table')).toHaveAttribute('data-total', '42');
    });
  });

  describe('graceful degradation', () => {
    it('renders with empty items when serverFetch returns !ok', async () => {
      apiMock.serverFetch.mockResolvedValue({ ok: false, status: 503 });

      render(await TurnEvaluationsPage());

      const table = screen.getByTestId('turn-evaluations-table');
      expect(table).toHaveAttribute('data-item-count', '0');
      expect(table).toHaveAttribute('data-total', '0');
    });

    it('does not call parseApiResponse when serverFetch returns !ok', async () => {
      apiMock.serverFetch.mockResolvedValue({ ok: false, status: 503 });

      await TurnEvaluationsPage();

      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('renders with empty items when parseApiResponse returns success:false', async () => {
      apiMock.parseApiResponse.mockResolvedValue({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No access' },
      });

      render(await TurnEvaluationsPage());

      expect(screen.getByTestId('turn-evaluations-table')).toHaveAttribute('data-item-count', '0');
    });

    it('renders with empty items and logs an error when serverFetch throws', async () => {
      apiMock.serverFetch.mockRejectedValue(new Error('network down'));

      render(await TurnEvaluationsPage());

      const table = screen.getByTestId('turn-evaluations-table');
      expect(table).toHaveAttribute('data-item-count', '0');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'turn evaluations page: initial fetch failed',
        expect.any(Error)
      );
    });

    it('falls back to EMPTY_META total=0 when parsePaginationMeta returns null (no meta)', async () => {
      // Response with no meta field — parsePaginationMeta returns null, page uses EMPTY_META
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeItem()],
        // deliberately omit meta
      });

      render(await TurnEvaluationsPage());

      // Items are passed through but meta falls back to EMPTY_META (total: 0)
      expect(screen.getByTestId('turn-evaluations-table')).toHaveAttribute('data-total', '0');
    });
  });
});
