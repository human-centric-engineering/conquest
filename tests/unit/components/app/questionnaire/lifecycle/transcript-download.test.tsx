// @vitest-environment happy-dom

/**
 * TranscriptDownload — respondent chat-transcript download menu (F7.6).
 *
 * Anti-green-bar: asserts each menu option hits the matching transcript route, that the
 * anonymous `X-Session-Token` header is sent only when a token is supplied, that the blob
 * is saved under the server's `Content-Disposition` filename, that "Copy to clipboard"
 * writes the fetched text via the Clipboard API and flashes a confirmation, and that a
 * failed request surfaces an action-specific inline error without downloading.
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

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

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

  it('copies the plain-text transcript to the clipboard and flashes a confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('You: hi\nAgent: hello'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // Define clipboard AFTER setup so userEvent's own clipboard install doesn't clobber it.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<TranscriptDownload sessionId="sess-1" accessToken="tok.sig" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /copy to clipboard/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('You: hi\nAgent: hello'));
    // Reuses the plain-text route and forwards the anonymous token.
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/app/questionnaire-sessions/sess-1/transcript.txt'
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['X-Session-Token']).toBe(
      'tok.sig'
    );
    // No file download for copy, and the trigger confirms success.
    expect(lastClick).toBeNull();
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('shows a copy-specific error when the clipboard write fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('transcript body')));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    render(<TranscriptDownload sessionId="sess-1" />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /copy to clipboard/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.?t copy/i);
  });
});

/**
 * `collapseLabel` — the strip's trigger gives up its words below `sm`, and keeps its name.
 *
 * On the lifecycle strip this button shares the status line with the coverage bar and the
 * reference chip, and at ~450px "Chat Transcript" plus a chevron was what tipped that line into a
 * collision. The words go; the glyph stays.
 *
 * The assertion that matters is `sr-only` rather than `hidden`. This text IS the button's
 * accessible name, and it is also how "Preparing…" and "Copied" reach a screen-reader user — so
 * `hidden` would leave a nameless icon, and an `aria-label` would name it but freeze it, drowning
 * both live states under one constant. `sr-only` is absolutely positioned, so it costs the
 * collapsed button no width while staying in the a11y tree.
 */
describe('collapsing the trigger label', () => {
  it('keeps the name when the words are visually collapsed', () => {
    render(<TranscriptDownload sessionId="sess-1" collapseLabel />);
    const trigger = screen.getByRole('button', { name: /chat transcript/i });
    const label = screen.getByText('Chat Transcript');
    expect(label).toHaveClass('max-sm:sr-only');
    expect(label).not.toHaveClass('hidden');
    expect(trigger).toContainElement(label);
  });

  it('leaves the label unconditional by default — the completion screen keeps its words', () => {
    // There, taking the transcript away is one of the two things the page is for; an icon-only
    // button on a phone would bury it.
    render(<TranscriptDownload sessionId="sess-1" variant="outline" />);
    expect(screen.getByText('Chat Transcript')).not.toHaveClass('max-sm:sr-only');
  });
});
