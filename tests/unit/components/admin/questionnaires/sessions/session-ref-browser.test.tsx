/**
 * SessionRefBrowser component tests.
 *
 * The alpha Sessions console table: renders enriched rows (ref, questionnaire, client, cohort/round,
 * status, turns, completion), links to analytics, opens a session in the drawer on row click, and drives
 * ALL page/sort state through the URL (`router.replace`, no scroll). Child surfaces (stats, filters,
 * drawer) are mocked so this isolates the table + pager + sort orchestration.
 *
 * @see components/admin/questionnaires/sessions/session-ref-browser.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { SessionRefBrowser } from '@/components/admin/questionnaires/sessions/session-ref-browser';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { AdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';
import type { PaginationMeta } from '@/types/api';

// Isolate the browser's own orchestration — the child surfaces have their own tests.
vi.mock('@/components/admin/questionnaires/sessions/session-stats', () => ({
  SessionStats: () => <div data-testid="session-stats" />,
}));
vi.mock('@/components/admin/questionnaires/sessions/session-filters', () => ({
  SessionFilters: () => <div data-testid="session-filters" />,
}));
vi.mock('@/components/admin/questionnaires/sessions/session-drawer', () => ({
  SessionDrawer: ({ item, open }: { item: AdminSessionRefItem | null; open: boolean }) =>
    open && item ? <div data-testid="drawer">Drawer: {item.refFormatted}</div> : null,
}));

function item(over: Partial<AdminSessionRefItem> = {}): AdminSessionRefItem {
  return {
    sessionId: 'sess-1',
    ref: '7F3K9M2P',
    refFormatted: '7F3K-9M2P',
    status: 'completed',
    isPreview: false,
    createdAt: '2026-07-16T10:00:00.000Z',
    questionnaireId: 'q-1',
    questionnaireTitle: 'Onboarding',
    versionId: 'v-1',
    versionNumber: 3,
    clientId: 'dc-1',
    clientName: 'Acme',
    roundId: 'r-1',
    roundName: 'Q3 Leadership',
    cohortId: 'c-1',
    cohortName: 'Leadership Team',
    turns: 4,
    answeredCount: 6,
    totalQuestions: 10,
    percentComplete: 60,
    durationMs: 23 * 60 * 1000,
    activeMs: 23 * 60 * 1000,
    sittings: 1,
    ...over,
  };
}

const META: PaginationMeta = { page: 1, limit: 25, total: 1, totalPages: 1 };
const STATS: AdminSessionStats = {
  total: 1,
  completed: 1,
  active: 0,
  avgCompletion: 60,
  byStatus: [],
  overTime: [],
  completionBuckets: [],
  byClient: [],
  byQuestionnaire: [],
};
const OPTIONS = {
  clients: [],
  questionnaires: [],
  cohorts: [],
  rounds: [],
  hasOpenEnded: false,
  hasUnassignedClient: false,
};

function renderBrowser(props: Partial<Parameters<typeof SessionRefBrowser>[0]> = {}) {
  return render(
    <SessionRefBrowser
      initialItems={[item()]}
      initialMeta={META}
      initialStats={STATS}
      options={OPTIONS}
      {...props}
    />
  );
}

/** Override the router with a stable `replace` spy and seed the URL query. */
function withRouter(searchParams = '') {
  const replace = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    replace,
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(searchParams) as never);
  return replace;
}

function okFetch(items: AdminSessionRefItem[], meta: Partial<PaginationMeta> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: items, meta: { ...META, ...meta } }),
  });
}

beforeEach(() => {
  withRouter();
  vi.stubGlobal('fetch', okFetch([item()]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SessionRefBrowser', () => {
  it('renders an enriched row (ref, questionnaire, client, cohort/round) and an analytics link', () => {
    renderBrowser();

    expect(screen.getByText('7F3K-9M2P')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Leadership Team')).toBeInTheDocument();
    expect(screen.getByText('Q3 Leadership')).toBeInTheDocument();
    expect(screen.getByText('23m')).toBeInTheDocument(); // duration

    const analyticsLink = screen.getByRole('link', { name: /analytics/i });
    expect(analyticsLink).toHaveAttribute('href', '/admin/questionnaires/q-1/v/v-1/analytics');
  });

  it('flags a staged session with its sitting count', () => {
    renderBrowser({
      initialItems: [
        item({ durationMs: 2 * 60 * 60 * 1000, activeMs: 20 * 60 * 1000, sittings: 3 }),
      ],
    });
    expect(screen.getByText('2h')).toBeInTheDocument();
    // The split indicator shows the number of sittings.
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('marks a preview session with the preview symbol when one is shown', () => {
    renderBrowser({ initialItems: [item({ isPreview: true })] });
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByTitle(/admin rehearsal/i)).toBeInTheDocument();
  });

  it('shows the turn count and completion percentage with an accessible title', () => {
    renderBrowser();
    expect(screen.getByText('4')).toBeInTheDocument();
    const pct = screen.getByText('60%');
    expect(pct).toHaveAttribute('title', '6 of 10 questions answered');
  });

  it('marks preview sessions and omits the round line when there is no round', () => {
    // The default fixture has roundName 'Q3 Leadership'; with no round, that line must not render.
    renderBrowser({ initialItems: [item({ isPreview: true, roundId: null, roundName: null })] });
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.queryByText('Q3 Leadership')).not.toBeInTheDocument();
    // The cohort cell still renders (it falls back to a dash), so the row isn't simply blank.
    expect(screen.getByText('Leadership Team')).toBeInTheDocument();
  });

  it('renders an empty state when there are no sessions', () => {
    renderBrowser({ initialItems: [], initialMeta: { ...META, total: 0 } });
    expect(screen.getByText(/no sessions match/i)).toBeInTheDocument();
  });

  it('opens the drawer on row click without navigating', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(screen.getByText('7F3K-9M2P'));
    expect(screen.getByTestId('drawer')).toHaveTextContent('Drawer: 7F3K-9M2P');
  });

  it('pages forward by replacing the URL with the next page', async () => {
    const user = userEvent.setup();
    const replace = withRouter();
    renderBrowser({ initialMeta: { page: 1, limit: 25, total: 30, totalPages: 2 } });

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('page=2'), { scroll: false });
  });

  it('disables Previous on the first page', () => {
    renderBrowser();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });

  it('toggles sort by turns via the column header', async () => {
    const user = userEvent.setup();
    const replace = withRouter();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: /turns/i }));
    const url = replace.mock.calls[0][0] as string;
    expect(url).toContain('sort=turns');
    expect(url).toContain('order=desc');
  });

  it('re-fetches the list + stats when the URL changes', async () => {
    const fetchMock = okFetch([item({ sessionId: 'sess-2' })], { page: 2 });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderBrowser();
    // Simulate a URL change (e.g. a filter or pager push landing back through searchParams).
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('page=2&status=active') as never
    );
    rerender(
      <SessionRefBrowser
        initialItems={[item()]}
        initialMeta={META}
        initialStats={STATS}
        options={OPTIONS}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/refs?') && u.includes('status=active'))).toBe(true);
    expect(urls.some((u) => u.includes('/refs/stats?') && u.includes('status=active'))).toBe(true);
  });

  it('surfaces an error when the list request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderBrowser();
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('page=2') as never);
    rerender(
      <SessionRefBrowser
        initialItems={[item()]}
        initialMeta={META}
        initialStats={STATS}
        options={OPTIONS}
      />
    );

    expect(await screen.findByText(/could not load sessions|request failed/i)).toBeInTheDocument();
  });
});
