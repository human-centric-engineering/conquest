/**
 * ReportConfigAssistant — component tests.
 *
 * Covers opening the panel, sending a turn (posts transcript + current config), rendering the reply
 * with per-field Apply buttons, and that Apply calls back into the editor.
 *
 * @see components/admin/questionnaires/report/report-config-assistant.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class extends Error {},
}));

import { apiClient } from '@/lib/api/client';
import { ReportConfigAssistant } from '@/components/admin/questionnaires/report/report-config-assistant';

type Mock = ReturnType<typeof vi.fn>;

function renderAssistant(onApply = vi.fn()) {
  render(
    <ReportConfigAssistant
      questionnaireId="qn-1"
      versionId="v1"
      current={{ instructions: 'existing', structure: '', backgroundContext: '' }}
      onApply={onApply}
    />
  );
  return { onApply };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReportConfigAssistant', () => {
  it('opens the panel from the launcher button', () => {
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: /Craft with AI assistant/i }));
    expect(screen.getByText(/Report design assistant/i)).toBeInTheDocument();
  });

  it('sends a turn with the transcript + current config and renders the reply + Apply buttons', async () => {
    (apiClient.post as unknown as Mock).mockResolvedValue({
      reply: 'How about this structure?',
      suggestions: { structure: 'Summary, themes, actions.' },
    });
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: /Craft with AI assistant/i }));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Help me' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });

    expect(await screen.findByText('How about this structure?')).toBeInTheDocument();

    const [path, opts] = (apiClient.post as unknown as Mock).mock.calls[0];
    expect(path).toBe('/api/v1/app/questionnaires/qn-1/versions/v1/report/craft');
    expect(opts.body.messages).toEqual([{ role: 'user', content: 'Help me' }]);
    expect(opts.body.current.instructions).toBe('existing');

    expect(screen.getByRole('button', { name: /Apply structure/i })).toBeInTheDocument();
  });

  it('applies a suggestion back into the editor', async () => {
    (apiClient.post as unknown as Mock).mockResolvedValue({
      reply: 'Try this.',
      suggestions: { instructions: 'Warm and concise.' },
    });
    const { onApply } = renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: /Craft with AI assistant/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });

    fireEvent.click(await screen.findByRole('button', { name: /Apply instructions/i }));
    expect(onApply).toHaveBeenCalledWith({ instructions: 'Warm and concise.' });
  });

  it('shows an error when the turn fails', async () => {
    (apiClient.post as unknown as Mock).mockRejectedValue(new Error('boom'));
    renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: /Craft with AI assistant/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(screen.getByText(/could not respond|boom/i)).toBeInTheDocument());
  });
});
