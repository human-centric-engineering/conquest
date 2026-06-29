/**
 * IntroBackgroundField — controlled markdown editor with upload / generate / refine helpers (F12.2).
 *
 * @see components/admin/questionnaires/intro-background-field.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: (...args: unknown[]) => apiPost(...args) },
  APIClientError: class APIClientError extends Error {},
}));

// Pass-through: lets test control the Response body via global.fetch while still
// exercising the success/error branching that the component does on body.success.
vi.mock('@/lib/api/parse-response', () => ({
  parseApiResponse: async (res: Response) => {
    const json: unknown = await res.json();
    return json;
  },
}));

import { IntroBackgroundField } from '@/components/admin/questionnaires/intro-background-field';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset global fetch so upload tests start clean.
  global.fetch = vi.fn();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for global.fetch mocks. */
function makeFetchResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IntroBackgroundField', () => {
  it('renders the editor with the three authoring helpers', () => {
    render(<IntroBackgroundField value="" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /upload document/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate with ai/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refine with ai/i })).toBeInTheDocument();
  });

  it('disables Refine when there is no current text, enables it once there is', () => {
    const { rerender } = render(<IntroBackgroundField value="" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /refine with ai/i })).toBeDisabled();
    rerender(<IntroBackgroundField value="Some background" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /refine with ai/i })).toBeEnabled();
  });

  it('propagates manual textarea edits via onChange', async () => {
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'Hi');
    expect(onChange).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Generate flow
  // -------------------------------------------------------------------------

  it('generates from a brief and pushes the result through onChange', async () => {
    apiPost.mockResolvedValue({ background: 'AI-written intro.' });
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    // Query the brief textarea by its placeholder (robust; does not rely on DOM order).
    const brief = screen.getByPlaceholderText(/acme is running this/i);
    await userEvent.type(brief, 'Acme team survey');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    expect(apiPost).toHaveBeenCalledWith(expect.stringContaining('/intro-background/author'), {
      body: { mode: 'generate', brief: 'Acme team survey' },
    });
    expect(onChange).toHaveBeenCalledWith('AI-written intro.');
  });

  it('shows an error when the generate API call rejects', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    apiPost.mockRejectedValue(new APIClientError('Server error'));
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    const brief = screen.getByPlaceholderText(/acme is running this/i);
    await userEvent.type(brief, 'Acme team survey');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  // Finding 4 — closing the generate popover clears the error message.
  it('clears the generate error when the popover is closed', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    apiPost.mockRejectedValue(new APIClientError('Oops'));
    render(<IntroBackgroundField value="" onChange={vi.fn()} />);

    // Open, trigger error.
    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    const brief = screen.getByPlaceholderText(/acme is running this/i);
    await userEvent.type(brief, 'anything');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => {
      expect(screen.getByText('Oops')).toBeInTheDocument();
    });

    // Close the popover by clicking the trigger button again (toggles open→closed).
    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));

    await waitFor(() => {
      expect(screen.queryByText('Oops')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Grounding tickbox — "use the questionnaire goal and questions"
  // -------------------------------------------------------------------------

  it('hides the grounding tickbox when no questionnaire/version is supplied', async () => {
    render(<IntroBackgroundField value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    expect(screen.queryByText(/use the questionnaire goal and questions/i)).not.toBeInTheDocument();
  });

  it('sends the version pair on generate when the tickbox is shown and left checked', async () => {
    apiPost.mockResolvedValue({ background: 'Grounded intro.' });
    const onChange = vi.fn();
    render(
      <IntroBackgroundField value="" onChange={onChange} questionnaireId="q-1" versionId="v-1" />
    );

    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    // The tickbox is rendered and checked by default.
    expect(screen.getByRole('checkbox')).toBeChecked();
    await userEvent.type(screen.getByPlaceholderText(/acme is running this/i), 'Acme survey');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    expect(apiPost).toHaveBeenCalledWith(expect.stringContaining('/intro-background/author'), {
      body: { mode: 'generate', brief: 'Acme survey', questionnaireId: 'q-1', versionId: 'v-1' },
    });
    expect(onChange).toHaveBeenCalledWith('Grounded intro.');
  });

  it('omits the version pair when the tickbox is unchecked', async () => {
    apiPost.mockResolvedValue({ background: 'Brief-only intro.' });
    render(
      <IntroBackgroundField value="" onChange={vi.fn()} questionnaireId="q-1" versionId="v-1" />
    );

    await userEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    await userEvent.click(screen.getByRole('checkbox')); // untick
    await userEvent.type(screen.getByPlaceholderText(/acme is running this/i), 'Acme survey');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    expect(apiPost).toHaveBeenCalledWith(expect.stringContaining('/intro-background/author'), {
      body: { mode: 'generate', brief: 'Acme survey' },
    });
  });

  // -------------------------------------------------------------------------
  // Refine flow (Finding 1)
  // -------------------------------------------------------------------------

  it('refines the current text and pushes the result through onChange', async () => {
    apiPost.mockResolvedValue({ background: 'Refined intro.' });
    const onChange = vi.fn();
    render(<IntroBackgroundField value="Original text" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /refine with ai/i }));
    const instruction = screen.getByPlaceholderText(/make it shorter/i);
    await userEvent.type(instruction, 'Make it warmer');
    await userEvent.click(screen.getByRole('button', { name: /^refine$/i }));

    expect(apiPost).toHaveBeenCalledWith(expect.stringContaining('/intro-background/author'), {
      body: {
        mode: 'refine',
        currentText: 'Original text',
        instruction: 'Make it warmer',
      },
    });
    expect(onChange).toHaveBeenCalledWith('Refined intro.');
  });

  it('shows an error when the refine API call rejects', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    apiPost.mockRejectedValue(new APIClientError('Refine failed'));
    const onChange = vi.fn();
    render(<IntroBackgroundField value="Original text" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /refine with ai/i }));
    const instruction = screen.getByPlaceholderText(/make it shorter/i);
    await userEvent.type(instruction, 'Make it shorter');
    await userEvent.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => {
      expect(screen.getByText('Refine failed')).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // File upload flow (Finding 2)
  // -------------------------------------------------------------------------

  it('extracts text from an uploaded file and calls onChange with it', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      makeFetchResponse({ success: true, data: { text: 'Extracted text.', truncated: false } })
    );
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);

    // The hidden file input exists in the DOM; fire change with a File to trigger onFilePicked.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const file = new File(['doc content'], 'test.pdf', { type: 'application/pdf' });
    // Use fireEvent for the hidden file input (userEvent cannot interact with hidden inputs).
    const { fireEvent } = await import('@testing-library/react');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('Extracted text.');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/intro-background/parse'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows an error when the parse endpoint returns success:false', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      makeFetchResponse({ success: false, error: { message: 'Could not parse PDF.' } })
    );
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bad'], 'bad.pdf', { type: 'application/pdf' });
    const { fireEvent } = await import('@testing-library/react');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(screen.getByText('Could not parse PDF.')).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does nothing when the file input change fires with no file selected', async () => {
    const onChange = vi.fn();
    render(<IntroBackgroundField value="" onChange={onChange} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const { fireEvent } = await import('@testing-library/react');
    // files is empty / undefined — simulates cancel.
    Object.defineProperty(fileInput, 'files', { value: [], configurable: true });
    fireEvent.change(fileInput);

    // Give async work a chance to run — nothing should happen.
    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
