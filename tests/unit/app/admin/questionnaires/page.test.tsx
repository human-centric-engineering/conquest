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

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isQuestionnairesEnabled: vi.fn(),
  isDataSlotsEnabled: vi.fn(),
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
vi.mock('@/components/admin/questionnaires/upload-questionnaire-dialog', () => ({
  UploadQuestionnaireDialog: () => <div data-testid="upload-dialog" />,
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
import { isQuestionnairesEnabled, isDataSlotsEnabled } from '@/lib/app/questionnaire/feature-flag';
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
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(true);
    vi.mocked(isDataSlotsEnabled).mockResolvedValue(false);

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
});
