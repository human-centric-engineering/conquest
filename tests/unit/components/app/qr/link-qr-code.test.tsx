/**
 * LinkQrCode — the download / copy-image actions and their failure paths.
 *
 * The rasterisation module is mocked at the boundary: it needs a real 2D canvas, which the
 * test DOM doesn't provide, and its own behaviour is covered in `render-qr-png.test.ts`.
 * What's asserted here is the component's contract — which action runs, what the file is
 * named, and what the user sees when the clipboard or the renderer lets them down.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkQrCode } from '@/components/app/qr/link-qr-code';

const { canCopyImages, copyPngToClipboard, downloadBlob, renderQrPngBlob } = vi.hoisted(() => ({
  canCopyImages: vi.fn(),
  copyPngToClipboard: vi.fn(),
  downloadBlob: vi.fn(),
  renderQrPngBlob: vi.fn(),
}));

vi.mock('@/lib/app/qr/render-qr-png', () => ({
  QR_LOGO_SRC: '/android-chrome-192x192.png',
  canCopyImages,
  copyPngToClipboard,
  downloadBlob,
  renderQrPngBlob,
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const URL_UNDER_TEST = 'https://conquest.example.com/q/clx1234567890abcdef';
const PNG = new Blob(['png'], { type: 'image/png' });

beforeEach(() => {
  canCopyImages.mockReturnValue(true);
  copyPngToClipboard.mockResolvedValue(true);
  renderQrPngBlob.mockResolvedValue(PNG);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LinkQrCode', () => {
  it('renders a labelled, scannable symbol for the URL', () => {
    render(<LinkQrCode url={URL_UNDER_TEST} label="Public link" />);

    const code = screen.getByRole('img', { name: 'QR code for Public link' });
    expect(code.querySelector('path')?.getAttribute('d')).toMatch(/^M\d/);
  });

  it('renders nothing when the URL cannot be encoded', () => {
    const { container } = render(<LinkQrCode url="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('grows the rendered size for a dense symbol rather than squeezing modules', () => {
    const short = 'https://cq.app/q/abc';
    const long = `https://questionnaires.a-long-client-subdomain.example.com/q/clx1234567890abcdef?i=${'a3f'.repeat(21)}b`;

    const { unmount } = render(<LinkQrCode url={short} />);
    const shortWidth = Number(screen.getByRole('img').getAttribute('width'));
    unmount();

    render(<LinkQrCode url={long} />);
    const longWidth = Number(screen.getByRole('img').getAttribute('width'));

    expect(longWidth).toBeGreaterThan(shortWidth);
  });

  describe('download', () => {
    it('saves the PNG under a filename derived from the label', async () => {
      const user = userEvent.setup();
      render(<LinkQrCode url={URL_UNDER_TEST} label="Public link" />);

      await user.click(screen.getByRole('button', { name: /download png/i }));

      await waitFor(() => expect(renderQrPngBlob).toHaveBeenCalledWith(URL_UNDER_TEST));
      expect(downloadBlob).toHaveBeenCalledWith(PNG, 'conquest-public-link.png');
    });

    it('falls back to a generic filename when unlabelled', async () => {
      const user = userEvent.setup();
      render(<LinkQrCode url={URL_UNDER_TEST} />);

      await user.click(screen.getByRole('button', { name: /download png/i }));

      await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(PNG, 'conquest-qr-code.png'));
    });

    it('surfaces a recoverable message when rendering fails', async () => {
      const user = userEvent.setup();
      renderQrPngBlob.mockRejectedValue(new Error('canvas exploded'));
      render(<LinkQrCode url={URL_UNDER_TEST} label="Public link" />);

      await user.click(screen.getByRole('button', { name: /download png/i }));

      // The link itself is still copyable, so the message points there rather than dead-ending.
      expect(await screen.findByText(/could not generate the image/i)).toBeInTheDocument();
      expect(downloadBlob).not.toHaveBeenCalled();
    });
  });

  describe('copy image', () => {
    it('is hidden where the browser cannot put images on the clipboard', async () => {
      canCopyImages.mockReturnValue(false);
      render(<LinkQrCode url={URL_UNDER_TEST} />);

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /copy image/i })).not.toBeInTheDocument()
      );
      // Download remains, so the action is never wholly unavailable.
      expect(screen.getByRole('button', { name: /download png/i })).toBeInTheDocument();
    });

    it('copies the PNG and confirms', async () => {
      const user = userEvent.setup();
      render(<LinkQrCode url={URL_UNDER_TEST} />);

      await user.click(await screen.findByRole('button', { name: /copy image/i }));

      await waitFor(() => expect(copyPngToClipboard).toHaveBeenCalledWith(PNG));
      expect(await screen.findByText('Copied')).toBeInTheDocument();
      expect(downloadBlob).not.toHaveBeenCalled();
    });

    it('downloads instead when the clipboard write is refused', async () => {
      const user = userEvent.setup();
      copyPngToClipboard.mockResolvedValue(false);
      render(<LinkQrCode url={URL_UNDER_TEST} label="Public link" />);

      await user.click(await screen.findByRole('button', { name: /copy image/i }));

      // The user still ends up holding the image rather than getting a silent no-op.
      await waitFor(() =>
        expect(downloadBlob).toHaveBeenCalledWith(PNG, 'conquest-public-link.png')
      );
      expect(screen.queryByText('Copied')).not.toBeInTheDocument();
    });

    it('re-arms the "Copied" reset on a rapid second copy', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<LinkQrCode url={URL_UNDER_TEST} />);
      const button = await screen.findByRole('button', { name: /copy image/i });

      await user.click(button);
      await screen.findByText('Copied');
      vi.advanceTimersByTime(1500);
      await user.click(button);
      await screen.findByText('Copied');

      // The first copy's timer must not survive to flip "Copied" back early — at 1.5s
      // past the second copy the label is still showing.
      vi.advanceTimersByTime(1000);
      expect(screen.getByText('Copied')).toBeInTheDocument();

      vi.advanceTimersByTime(1500);
      await waitFor(() => expect(screen.queryByText('Copied')).not.toBeInTheDocument());
      vi.useRealTimers();
    });

    it('clears the pending "Copied" reset on unmount', async () => {
      const user = userEvent.setup();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const { unmount } = render(<LinkQrCode url={URL_UNDER_TEST} />);

      await user.click(await screen.findByRole('button', { name: /copy image/i }));
      await screen.findByText('Copied');

      // Identify the component's own 2000ms reset timer. Asserting merely that
      // `clearTimeout` fired is a false green: testing-library's `findBy*` calls it
      // internally, so that assertion passes even with the cleanup effect deleted.
      const resetIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 2000);
      expect(resetIndex).toBeGreaterThanOrEqual(0);
      const resetTimerId = setTimeoutSpy.mock.results[resetIndex].value;

      const clearsBefore = clearTimeoutSpy.mock.calls.length;
      unmount();

      // Issue #301: an un-cleared reset fires setState on an unmounted component.
      expect(clearTimeoutSpy.mock.calls.length).toBe(clearsBefore + 1);
      expect(clearTimeoutSpy).toHaveBeenLastCalledWith(resetTimerId);
    });
  });
});
