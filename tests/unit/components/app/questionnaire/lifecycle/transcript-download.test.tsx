/**
 * TranscriptDownload — respondent chat-transcript download menu (F7.6).
 *
 * Anti-green-bar: asserts each menu option hits the matching transcript route, that the
 * anonymous `X-Session-Token` header is sent only when a token is supplied, that the blob
 * is saved under the server's `Content-Disposition` filename, and that a failed request
 * surfaces an inline error without downloading.
 *
 * @see components/app/questionnaire/lifecycle/transcript-download.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TranscriptDownload } from '@/components/app/questionnaire/lifecycle/transcript-download';

interface ClickCapture {
  href: string;
  download: string;
}
let lastClick: ClickCapture | null = null;

function pdfResponse(name = 'transcript-onboarding-survey-v2.pdf'): Response {
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

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /transcript/i }));
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

describe('TranscriptDownload', () => {
  it('downloads the themed PDF via the transcript.pdf route, named from the disposition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<TranscriptDownload sessionId="sess-1" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /themed pdf/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/app/questionnaire-sessions/sess-1/transcript.pdf'
    );
    await waitFor(() => expect(lastClick).not.toBeNull());
    expect(lastClick!.download).toBe('transcript-onboarding-survey-v2.pdf');
  });

  it('downloads plain text via the transcript.txt route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse('transcript-onboarding-survey-v2.txt'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<TranscriptDownload sessionId="sess-1" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /plain text/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/v1/app/questionnaire-sessions/sess-1/transcript.txt'
      )
    );
  });

  it('sends the X-Session-Token header for an anonymous session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<TranscriptDownload sessionId="sess-1" accessToken="tok.sig" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /themed pdf/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)['X-Session-Token']).toBe('tok.sig');
  });

  it('does NOT send a token header for an authenticated session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<TranscriptDownload sessionId="sess-1" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /themed pdf/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
  });

  it('surfaces an inline error when the request fails, without downloading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<TranscriptDownload sessionId="sess-1" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /themed pdf/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.?t download/i);
    expect(lastClick).toBeNull();
  });
});
