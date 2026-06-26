/**
 * SessionDownloads — admin per-session download toolbar (P8 admin session views).
 *
 * Anti-green-bar: asserts the report button and each transcript menu option hit the matching
 * admin route (questionnaire-scoped), that requests carry the admin cookie (`credentials:
 * 'same-origin'`) and NO `X-Session-Token` (that's the respondent surface), that the blob is
 * saved under the server's `Content-Disposition` filename, and that a failed request surfaces
 * an inline error without downloading.
 *
 * @see components/admin/questionnaires/sessions/session-downloads.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionDownloads } from '@/components/admin/questionnaires/sessions/session-downloads';

interface ClickCapture {
  href: string;
  download: string;
}
let lastClick: ClickCapture | null = null;

function fileResponse(name: string): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-disposition' ? `attachment; filename="${name}"` : null,
    },
    blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  } as unknown as Response;
}

async function openTranscriptMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^transcript$/i }));
}

beforeEach(() => {
  lastClick = null;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
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

describe('SessionDownloads', () => {
  it('downloads the report via the admin export.pdf route, named from the disposition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse('report.pdf'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<SessionDownloads questionnaireId="qn-1" sessionId="sess-1" />);
    await user.click(screen.getByRole('button', { name: /download report/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/app/questionnaires/qn-1/sessions/sess-1/export.pdf'
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
    await waitFor(() => expect(lastClick).not.toBeNull());
    expect(lastClick!.download).toBe('report.pdf');
  });

  it('downloads the themed PDF transcript via the admin transcript.pdf route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse('transcript-onboarding-v2.pdf'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<SessionDownloads questionnaireId="qn-1" sessionId="sess-1" />);
    await openTranscriptMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /themed pdf/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/app/questionnaires/qn-1/sessions/sess-1/transcript.pdf'
    );
  });

  it('downloads plain text via the admin transcript.txt route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse('transcript-onboarding-v2.txt'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<SessionDownloads questionnaireId="qn-1" sessionId="sess-1" />);
    await openTranscriptMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /plain text/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/v1/app/questionnaires/qn-1/sessions/sess-1/transcript.txt'
      )
    );
  });

  it('never sends an X-Session-Token header (admin surface, cookie auth)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fileResponse('report.pdf'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<SessionDownloads questionnaireId="qn-1" sessionId="sess-1" />);
    await user.click(screen.getByRole('button', { name: /download report/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it('surfaces an inline error when the request fails, without downloading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<SessionDownloads questionnaireId="qn-1" sessionId="sess-1" />);
    await user.click(screen.getByRole('button', { name: /download report/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.?t download/i);
    expect(lastClick).toBeNull();
  });
});
