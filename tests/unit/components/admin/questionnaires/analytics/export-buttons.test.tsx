/**
 * ExportButtons component tests (F8.2).
 *
 * Anti-green-bar: asserts the buttons hit the version-export endpoint with the page's
 * current filter query plus the right `format`, trigger a blob download using the
 * server-supplied `Content-Disposition` filename, and surface the 429 (rate-limited)
 * and generic failure cases inline without downloading.
 *
 * @see components/admin/questionnaires/analytics/export-buttons.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExportButtons } from '@/components/admin/questionnaires/analytics/export-buttons';
import { API } from '@/lib/api/endpoints';

const BASE = API.APP.QUESTIONNAIRES.versionExport('qn-1', 'v1');

interface ClickCapture {
  href: string;
  download: string;
}
let lastClick: ClickCapture | null = null;

function mockResponse(over: Partial<Response> & { dispositionName?: string } = {}): Response {
  const name = over.dispositionName ?? 'results-onboarding-v2-2026-01-10.csv';
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-disposition' ? `attachment; filename="${name}"` : null,
    },
    blob: async () => new Blob(['payload']),
  } as unknown as Response;
}

beforeEach(() => {
  lastClick = null;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    lastClick = { href: this.href, download: this.download };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ExportButtons', () => {
  it('fetches CSV with the current filter query appended before format, and downloads the named file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportButtons questionnaireId="qn-1" versionId="v1" query="?from=2026-01-01" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}?from=2026-01-01&format=csv`, {
      credentials: 'same-origin',
    });
    await waitFor(() => expect(lastClick).not.toBeNull());
    expect(lastClick!.download).toBe('results-onboarding-v2-2026-01-10.csv');
  });

  it('starts the query string with ? when no filter is active (JSON)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ dispositionName: 'x.json' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportButtons questionnaireId="qn-1" versionId="v1" query="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}?format=json`, expect.anything())
    );
  });

  it('surfaces a rate-limit message on 429 and does not download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 429 })));

    render(<ExportButtons questionnaireId="qn-1" versionId="v1" query="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText(/too many exports/i)).toBeInTheDocument();
    expect(lastClick).toBeNull();
  });

  it('surfaces a generic failure on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500 })));

    render(<ExportButtons questionnaireId="qn-1" versionId="v1" query="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    expect(await screen.findByText(/export failed/i)).toBeInTheDocument();
    expect(lastClick).toBeNull();
  });
});
