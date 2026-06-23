import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CopyLinkField } from '@/components/admin/questionnaires/copy-link-field';

beforeEach(() => {
  vi.clearAllMocks();
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
});
