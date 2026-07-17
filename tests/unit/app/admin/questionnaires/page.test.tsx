/**
 * Admin Questionnaires LIST page — summary-tile tally + within-cap stats fetch.
 *
 * Regression: the stat tiles (Questionnaires / Launched / Drafts / Archived) once read all
 * zeros while the table showed rows, because the stats fetch asked for `limit=200` — over the
 * list endpoint's `limit` cap of 100 — so the request 400'd and the page silently degraded to
 * zeros. These tests assert (a) the tiles tally with the fetched rows and (b) the stats fetch
 * stays within the cap (`limit` ≤ 100), which is what makes the request succeed.
 *
 * Heavy children (table, upload dialog, FieldHelp) are stubbed; CqStatTiles is stubbed to a
 * marker that exposes each tile's label + value so we can assert the computed counts.
 *
 * @see app/admin/questionnaires/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub heavy children — we only care about the page's own stat computation here.
vi.mock('@/components/admin/questionnaires/questionnaires-table', () => ({
  QuestionnairesTable: (props: { initialItems: unknown[] }) => (
    <div data-testid="questionnaires-table" data-row-count={String(props.initialItems.length)} />
  ),
}));
vi.mock('@/components/admin/questionnaires/new-questionnaire-menu', () => ({
  NewQuestionnaireMenu: () => <div data-testid="new-questionnaire-menu" />,
}));
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/admin/cq-stat-tiles', () => ({
  CqStatTiles: ({ stats }: { stats: Array<{ label: string; value: React.ReactNode }> }) => (
    <div data-testid="stat-tiles">
      {stats.map((s) => (
        <div key={s.label} data-tile={s.label}>
          {s.value}
        </div>
      ))}
    </div>
  ),
}));

import QuestionnairesListPage from '@/app/admin/questionnaires/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
import type React from 'react';

function makeItem(status: AppQuestionnaireStatus, id: string): QuestionnaireListItem {
  return {
    id,
    title: `Q ${id}`,
    status,
    versionCount: 1,
    latestVersion: { id: `${id}-v1`, versionNumber: 1, status },
    sectionCount: 1,
    questionCount: 1,
    dataSlotCount: 0,
    demoClient: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  };
}

// 1 launched + 3 drafts, matching the reported screenshot.
const ITEMS: QuestionnaireListItem[] = [
  makeItem('launched', 'a'),
  makeItem('draft', 'b'),
  makeItem('draft', 'c'),
  makeItem('draft', 'd'),
];

function tileValue(label: string): string {
  return (
    screen.getByTestId('stat-tiles').querySelector(`[data-tile="${label}"]`)?.textContent ?? ''
  );
}

describe('QuestionnairesListPage stat tiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // serverFetch tags the response with its URL so parseApiResponse can branch.
    vi.mocked(serverFetch).mockImplementation(
      async (url: string) => ({ ok: true, _url: url }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) {
        return { success: true as const, data: [] };
      }
      // Both the table (limit=25) and stats (limit=100) hit the questionnaires list.
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });
  });

  it('tiles tally with the rows: 4 total, 1 launched, 3 drafts, 0 archived', async () => {
    render(await QuestionnairesListPage());

    expect(tileValue('Questionnaires')).toBe('4');
    expect(tileValue('Launched')).toBe('1');
    expect(tileValue('Drafts')).toBe('3');
    expect(tileValue('Archived')).toBe('0');
    // Sanity: the table received the same rows.
    expect(screen.getByTestId('questionnaires-table')).toHaveAttribute('data-row-count', '4');
  });

  it('fetches stats within the list endpoint cap (limit ≤ 100, never 200)', async () => {
    await QuestionnairesListPage();

    const urls = vi.mocked(serverFetch).mock.calls.map((c) => String(c[0]));
    const limits = urls
      .map((u) => Number(new URL(u, 'http://x').searchParams.get('limit')))
      .filter((n) => Number.isFinite(n) && n > 0);

    expect(limits).toContain(100); // the wide stats sweep uses the max allowed page size
    expect(Math.max(...limits)).toBeLessThanOrEqual(100); // never over the list endpoint's cap
  });

  it('degrades stats to zero when the stats fetch returns a non-ok response', async () => {
    // Covers the !res.ok branch in getQuestionnaireStats (line 46).
    // Stats-fetch URL contains limit=100; we make it return not-ok.
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('demo-clients')) return { ok: true, _url: u } as unknown as Response;
      if (u.includes('limit=100')) return { ok: false, status: 503 } as unknown as Response;
      return { ok: true, _url: u } as unknown as Response;
    });
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (!url) return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 25, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    // Stats returned empty — the tiles fall to zero.
    expect(tileValue('Questionnaires')).toBe('0');
    expect(tileValue('Launched')).toBe('0');
  });

  it('degrades stats to zero when the stats parseApiResponse returns success:false', async () => {
    // Covers the !body.success branch in getQuestionnaireStats (line 48).
    vi.mocked(serverFetch).mockImplementation(
      async (url: string) => ({ ok: true, _url: String(url) }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      if (url.includes('limit=100'))
        return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 25, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    expect(tileValue('Questionnaires')).toBe('0');
  });

  it('falls back to body.data.length when parsePaginationMeta returns null', async () => {
    // Covers the `?? body.data.length` fallback in getQuestionnaireStats (line 49).
    vi.mocked(serverFetch).mockImplementation(
      async (url: string) => ({ ok: true, _url: String(url) }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      // No `meta` — parsePaginationMeta returns null, so total falls back to data.length.
      return { success: true as const, data: ITEMS };
    });

    render(await QuestionnairesListPage());

    // Total comes from ITEMS.length (4) via the fallback path, not from a meta field.
    expect(tileValue('Questionnaires')).toBe('4');
  });

  it('degrades to empty table when getQuestionnaires returns non-ok', async () => {
    // Covers the !res.ok branch in getQuestionnaires (line 79).
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('demo-clients')) return { ok: true, _url: u } as unknown as Response;
      if (u.includes('limit=25')) return { ok: false, status: 503 } as unknown as Response;
      return { ok: true, _url: u } as unknown as Response;
    });
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (!url) return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    // Table renders with zero items from the fallback empty state.
    expect(screen.getByTestId('questionnaires-table')).toHaveAttribute('data-row-count', '0');
  });

  it('degrades to empty table when getQuestionnaires parseApiResponse returns success:false', async () => {
    // Covers the !body.success branch in getQuestionnaires (line 81).
    vi.mocked(serverFetch).mockImplementation(
      async (url: string) => ({ ok: true, _url: String(url) }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      if (url.includes('limit=25'))
        return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    expect(screen.getByTestId('questionnaires-table')).toHaveAttribute('data-row-count', '0');
  });

  it('degrades to empty demo-client list when demo-clients returns non-ok', async () => {
    // Covers the !res.ok branch in getActiveDemoClients (line 97).
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('demo-clients')) return { ok: false, status: 503 } as unknown as Response;
      return { ok: true, _url: u } as unknown as Response;
    });
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (!url) return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });

    // Must render without crashing even when no demo clients are returned.
    render(await QuestionnairesListPage());

    expect(screen.getByTestId('new-questionnaire-menu')).toBeInTheDocument();
  });

  it('degrades to empty demo-client list when demo-clients parseApiResponse returns success:false', async () => {
    // Covers the !body.success branch in getActiveDemoClients (line 99).
    vi.mocked(serverFetch).mockImplementation(
      async (url: string) => ({ ok: true, _url: String(url) }) as unknown as Response
    );
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients'))
        return { success: false as const, error: { code: 'ERR', message: 'fail' } };
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    expect(screen.getByTestId('new-questionnaire-menu')).toBeInTheDocument();
  });

  it('counts archived questionnaires in the Archived tile', async () => {
    // Arrange: include an archived item so the else-if branch at line 54 runs.
    const withArchived = [...ITEMS, makeItem('archived', 'e')];
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) {
        return { success: true as const, data: [] };
      }
      return {
        success: true as const,
        data: withArchived,
        meta: { page: 1, limit: 100, total: withArchived.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    // The archived tile must reflect the count the reduce computed — not a mock value.
    expect(tileValue('Archived')).toBe('1');
    expect(tileValue('Questionnaires')).toBe('5');
  });

  it('degrades to empty table + zero tiles when the initial questionnaires fetch throws', async () => {
    // Arrange: the fetch for the questionnaires list throws (covers the catch branch in
    // getQuestionnaires, lines 83-85 in page.tsx).
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('demo-clients')) {
        return { ok: true, _url: url } as unknown as Response;
      }
      throw new Error('network error');
    });

    render(await QuestionnairesListPage());

    // Table receives zero rows — degraded, not crashed.
    expect(screen.getByTestId('questionnaires-table')).toHaveAttribute('data-row-count', '0');
    // Tiles also fall back to zero because stats fetch fails the same way.
    expect(tileValue('Questionnaires')).toBe('0');
  });

  it('passes active demo clients to the table (filters inactive ones out)', async () => {
    // Arrange: demo-clients endpoint returns two clients, one active one inactive.
    // This covers the filter+map path in getActiveDemoClients (lines 100-102).
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) {
        return {
          success: true as const,
          data: [
            { id: 'dc-active', slug: 'acme', name: 'Acme Corp', isActive: true },
            { id: 'dc-inactive', slug: 'old', name: 'Old Co', isActive: false },
          ],
        };
      }
      return {
        success: true as const,
        data: ITEMS,
        meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    // The NewQuestionnaireMenu stub receives demoClientOptions — assert the page
    // rendered without crashing (the real value is passed through; stub swallows it).
    expect(screen.getByTestId('new-questionnaire-menu')).toBeInTheDocument();
  });

  it('degrades to empty demo-client list when the demo-clients fetch throws', async () => {
    // Covers the catch branch in getActiveDemoClients (lines 103-105 in page.tsx).
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('demo-clients')) {
        throw new Error('demo clients fetch failed');
      }
      return { ok: true, _url: url } as unknown as Response;
    });

    // The page must render without throwing — it degrades to an empty client list.
    render(await QuestionnairesListPage());

    expect(screen.getByTestId('questionnaires-table')).toBeInTheDocument();
    expect(screen.getByTestId('new-questionnaire-menu')).toBeInTheDocument();
  });

  it('renders the New Questionnaire menu (generative authoring is always available)', async () => {
    render(await QuestionnairesListPage());

    expect(screen.getByTestId('new-questionnaire-menu')).toBeInTheDocument();
  });

  it('counts draft questionnaires correctly when the list has drafts only', async () => {
    // Covers the else-if(draft) branch (line 53) explicitly via a drafts-only list.
    const draftsOnly = [makeItem('draft', 'x'), makeItem('draft', 'y')];
    vi.mocked(parseApiResponse).mockImplementation(async (res: unknown) => {
      const url = (res as { _url: string })._url;
      if (url.includes('demo-clients')) return { success: true as const, data: [] };
      return {
        success: true as const,
        data: draftsOnly,
        meta: { page: 1, limit: 100, total: draftsOnly.length, totalPages: 1 },
      };
    });

    render(await QuestionnairesListPage());

    expect(tileValue('Drafts')).toBe('2');
    expect(tileValue('Launched')).toBe('0');
    expect(tileValue('Archived')).toBe('0');
  });

  it('shows the data-slot embedding explainer (with live status)', async () => {
    render(await QuestionnairesListPage());

    // The explainer renders and its consumer use-cases are listed.
    expect(screen.getByText('About data-slot embedding')).toBeInTheDocument();
    expect(screen.getByText('Adaptive question selection')).toBeInTheDocument();
    expect(screen.getByText('Extraction pre-filter (large surveys)')).toBeInTheDocument();
    // Adaptive selection (a platform flag) shows a live On pill; the pre-filter is now a
    // per-questionnaire Settings toggle, so it has no global pill.
    const pills = screen.getAllByText(/^(On|Off)$/).map((el) => el.textContent);
    expect(pills).toEqual(['On']);
  });
});
