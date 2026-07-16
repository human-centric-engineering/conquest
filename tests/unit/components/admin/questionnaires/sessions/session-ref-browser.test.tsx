/**
 * SessionRefBrowser component tests.
 *
 * The alpha ref browser table: renders rows with a ref deep-link to the session viewer + an analytics
 * link, searches by ref, filters by status, and pages. It reads the enriched list endpoint via
 * `fetch` + `parseApiResponse` (no per-row calls).
 *
 * @see components/admin/questionnaires/sessions/session-ref-browser.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionRefBrowser } from '@/components/admin/questionnaires/sessions/session-ref-browser';
import type { AdminSessionRefItem } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import type { PaginationMeta } from '@/types/api';

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
    ...over,
  };
}

const META: PaginationMeta = { page: 1, limit: 25, total: 1, totalPages: 1 };

function mockFetchOnce(items: AdminSessionRefItem[], meta: Partial<PaginationMeta> = {}) {
  const body = { success: true, data: items, meta: { ...META, ...meta } };
  return vi.fn().mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetchOnce([item()]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionRefBrowser', () => {
  it('renders a ref row with the viewer deep-link and an analytics link', () => {
    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);

    const refLink = screen.getByRole('link', { name: /7F3K-9M2P/ });
    expect(refLink).toHaveAttribute('href', '/admin/questionnaires/q-1/v/v-1/sessions/sess-1');
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();

    const analyticsLink = screen.getByRole('link', { name: /analytics/i });
    expect(analyticsLink).toHaveAttribute('href', '/admin/questionnaires/q-1/v/v-1/analytics');
  });

  it('marks preview sessions', () => {
    render(<SessionRefBrowser initialItems={[item({ isPreview: true })]} initialMeta={META} />);
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('renders an empty state when there are no sessions', () => {
    render(<SessionRefBrowser initialItems={[]} initialMeta={{ ...META, total: 0 }} />);
    expect(screen.getByText(/no sessions found/i)).toBeInTheDocument();
  });

  it('searches by ref — issues a fetch with the q param and renders the result', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchOnce([item({ sessionId: 'sess-9', refFormatted: '99999999' })]);
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    await user.type(screen.getByLabelText(/support reference/i), '9999');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=9999');
    expect(url).toContain('page=1');
  });

  it('pages forward, requesting the next page', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchOnce([item({ sessionId: 'sess-2' })], {
      page: 2,
      total: 30,
      totalPages: 2,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SessionRefBrowser
        initialItems={[item()]}
        initialMeta={{ page: 1, limit: 25, total: 30, totalPages: 2 }}
      />
    );
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0] as string).toContain('page=2');
  });

  it('filters by status — issues a fetch with the status param', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchOnce([item({ status: 'active' })]);
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'active' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0] as string).toContain('status=active');
  });

  it('pages forward then back to page 1', async () => {
    const user = userEvent.setup();
    // The server always seeds page 1, so exercise Previous by going Next first.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [item()],
          meta: { ...META, page: 2, total: 30, totalPages: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [item()],
          meta: { ...META, page: 1, total: 30, totalPages: 2 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SessionRefBrowser
        initialItems={[item()]}
        initialMeta={{ page: 1, limit: 25, total: 30, totalPages: 2 }}
      />
    );
    await user.click(screen.getByRole('button', { name: /next/i }));
    // Once the page-2 result lands, Previous becomes enabled.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /previous/i })).not.toBeDisabled()
    );
    expect(fetchMock.mock.calls[0][0] as string).toContain('page=2');

    await user.click(screen.getByRole('button', { name: /previous/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0] as string).toContain('page=1');
  });

  it('surfaces an error when the list request fails (non-ok response)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/list request failed/i)).toBeInTheDocument();
  });

  it('surfaces an error on a 200 response with success:false', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: { code: 'X', message: 'Y' } }),
      })
    );

    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/list request failed/i)).toBeInTheDocument();
  });

  it('falls back to a generic message when the request rejects with a non-Error', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'));

    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/could not load sessions/i)).toBeInTheDocument();
  });

  it('resets to page 1 when searching from a later page', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      // Next → page 2
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [item()],
          meta: { ...META, page: 2, total: 30, totalPages: 2 },
        }),
      })
      // Search from page 2 → resets to page 1
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [item()],
          meta: { ...META, page: 1, total: 30, totalPages: 2 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SessionRefBrowser
        initialItems={[item()]}
        initialMeta={{ page: 1, limit: 25, total: 30, totalPages: 2 }}
      />
    );
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /previous/i })).not.toBeDisabled()
    );

    await user.type(screen.getByLabelText(/support reference/i), '9999');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const url = fetchMock.mock.calls[1][0] as string;
    expect(url).toContain('page=1');
    expect(url).toContain('q=9999');
  });

  it('disables Previous on the first page', () => {
    render(<SessionRefBrowser initialItems={[item()]} initialMeta={META} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });
});
