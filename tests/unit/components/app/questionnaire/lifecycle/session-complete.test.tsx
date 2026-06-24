/**
 * SessionComplete — the post-submission confirmation (F7.3, + F7.4 PDF download).
 *
 * @see components/app/questionnaire/lifecycle/session-complete.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The completion screen polls the report view on mount; stub it to "no report configured" so these
// base-screen tests exercise the default responses-PDF download path (report behaviour is covered in
// session-complete-report.test.tsx).
vi.mock('@/lib/hooks/use-respondent-report', () => ({
  // Match the real UseRespondentReportResult shape (view, loaded, timedOut, retry).
  useRespondentReport: () => ({
    view: { enabled: false },
    loaded: true,
    timedOut: false,
    retry: () => {},
  }),
}));

import { SessionComplete } from '@/components/app/questionnaire/lifecycle/session-complete';

describe('SessionComplete', () => {
  it('shows the thank-you heading', () => {
    render(<SessionComplete sessionId="sess-1" answeredCount={null} />);
    expect(
      screen.getByRole('heading', { name: /your responses are submitted/i })
    ).toBeInTheDocument();
  });

  it('acknowledges the captured-answer count when known', () => {
    render(<SessionComplete sessionId="sess-1" answeredCount={5} />);
    expect(screen.getByText(/captured 5 answers/i)).toBeInTheDocument();
  });

  it('singularises one captured answer', () => {
    render(<SessionComplete sessionId="sess-1" answeredCount={1} />);
    expect(screen.getByText(/captured 1 answer\b/i)).toBeInTheDocument();
  });

  it('falls back to a generic close when the count is zero', () => {
    render(<SessionComplete sessionId="sess-1" answeredCount={0} />);
    expect(screen.getByText(/nothing more you need to do/i)).toBeInTheDocument();
  });

  it('falls back to a generic close when the count is unknown (null)', () => {
    render(<SessionComplete sessionId="sess-1" answeredCount={null} />);
    expect(screen.getByText(/nothing more you need to do/i)).toBeInTheDocument();
  });

  describe('PDF download (F7.4)', () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
      // happy-dom doesn't implement the object-URL API the download path uses.
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      createObjectURL.mockClear();
      revokeObjectURL.mockClear();
    });

    it('fetches the export route and triggers a blob download', async () => {
      const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
      vi.mocked(fetch).mockResolvedValue(
        new Response(blob, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      );

      render(<SessionComplete sessionId="sess-1" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /download pdf/i }));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/app/questionnaire-sessions/sess-1/export.pdf');
    });

    it('sends the X-Session-Token header for an anonymous session', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['%PDF-1.7']), { status: 200 }));

      render(<SessionComplete sessionId="sess-1" accessToken="tok.sig" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /download pdf/i }));

      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const init = vi.mocked(fetch).mock.calls[0][1];
      expect((init?.headers as Record<string, string>)['X-Session-Token']).toBe('tok.sig');
    });

    it('does NOT send a token header for an authenticated session', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['%PDF-1.7']), { status: 200 }));

      render(<SessionComplete sessionId="sess-1" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /download pdf/i }));

      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const init = vi.mocked(fetch).mock.calls[0][1];
      expect((init?.headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
    });

    it('surfaces a transient error when the request fails', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

      render(<SessionComplete sessionId="sess-1" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /download pdf/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.?t prepare your pdf/i);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('disables the button and shows a preparing state while the fetch is in flight', async () => {
      // A never-resolving fetch keeps the download in flight so the in-flight UI is observable.
      vi.mocked(fetch).mockReturnValue(new Promise<Response>(() => {}));

      render(<SessionComplete sessionId="sess-1" answeredCount={3} />);
      await userEvent.click(screen.getByRole('button', { name: /download pdf/i }));

      const button = await screen.findByRole('button', { name: /preparing/i });
      expect(button).toBeDisabled();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    // test-review:accept coverage — the inFlightRef double-click guard (session-complete.tsx:46)
    // backstops a real-browser same-tick double-click; the `disabled={downloading}` attribute
    // (asserted above) blocks any second handler invocation through testing-library, so the ref
    // branch is unreachable via DOM interaction. Covered by the disabled-state test instead.
    it.todo('no-ops a second click that races the disabled attribute (browser-only path)');
  });
});
