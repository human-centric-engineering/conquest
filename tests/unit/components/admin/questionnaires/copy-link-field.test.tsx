import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CopyLinkField } from '@/components/admin/questionnaires/copy-link-field';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // The copy test redefines navigator.clipboard; defineProperty survives clearAllMocks.
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyLinkField', () => {
  it('renders the URL in a read-only input the user can see', () => {
    render(<CopyLinkField url="https://app.example/q/v1" label="Public link" />);
    expect(screen.getByDisplayValue('https://app.example/q/v1')).toBeInTheDocument();
    expect(screen.getByLabelText('Public link')).toHaveAttribute('readonly');
  });

  it('copies the URL to the clipboard and flips to "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<CopyLinkField url="https://app.example/q/v1?i=tok" />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.example/q/v1?i=tok'));
    await screen.findByText('Copied');
  });

  it('renders an optional note', () => {
    render(<CopyLinkField url="https://app.example/q/v1" note="Activates once launched." />);
    expect(screen.getByText('Activates once launched.')).toBeInTheDocument();
  });

  describe('QR code', () => {
    it('offers no QR affordance unless asked for one', () => {
      render(<CopyLinkField url="https://app.example/q/v1" label="Public link" />);
      expect(screen.queryByRole('button', { name: /qr/i })).not.toBeInTheDocument();
    });

    it('keeps the code collapsed until the toggle is pressed', () => {
      render(<CopyLinkField url="https://app.example/q/v1" label="Public link" showQr />);

      const toggle = screen.getByRole('button', { name: /qr code/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('reveals a scannable code for the URL, then hides it again', () => {
      render(<CopyLinkField url="https://app.example/q/v1" label="Public link" showQr />);

      fireEvent.click(screen.getByRole('button', { name: /qr code/i }));

      const code = screen.getByRole('img', { name: 'QR code for Public link' });
      expect(code.tagName.toLowerCase()).toBe('svg');
      // A real symbol, not an empty frame: the module path must carry drawing commands.
      expect(code.querySelector('path')?.getAttribute('d')).toMatch(/^M\d/);
      expect(screen.getByRole('button', { name: /download png/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /hide qr/i }));
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('names the code from qrLabel when the surrounding UI already labels the link', () => {
      render(<CopyLinkField url="https://app.example/q/v1?i=tok" showQr qrLabel="No-login link" />);

      fireEvent.click(screen.getByRole('button', { name: /qr code/i }));

      expect(screen.getByRole('img', { name: 'QR code for No-login link' })).toBeInTheDocument();
      // qrLabel must not leak into the visible form as a field label.
      expect(screen.queryByText('No-login link')).not.toBeInTheDocument();
    });

    it('encodes the URL it was given, not a stale one', () => {
      const { rerender } = render(<CopyLinkField url="https://app.example/q/aaa" showQr />);
      fireEvent.click(screen.getByRole('button', { name: /qr code/i }));
      const first = screen.getByRole('img').querySelector('path')?.getAttribute('d');

      rerender(<CopyLinkField url="https://app.example/q/bbb" showQr />);
      const second = screen.getByRole('img').querySelector('path')?.getAttribute('d');

      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });
});
