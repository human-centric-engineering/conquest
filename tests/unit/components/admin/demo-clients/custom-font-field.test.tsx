// @vitest-environment happy-dom

/**
 * CustomFontField component tests.
 *
 * The escape hatch for a brand with its own face: the admin names two Google Fonts families and
 * a button fetches them once, self-hosted from here on. The behaviours that matter:
 *
 *  - loading happens on an explicit action, not as part of the surrounding form's Save — a POST
 *    to the fonts endpoint writes the families and the files immediately
 *  - "loading is not saving": what is stored reflects back at once, independent of any parent
 *    form state (this field takes no `onChange` — there is nothing for a save to carry)
 *  - a family Google Fonts does not recognise comes back as a 400 naming it, and that message is
 *    shown verbatim rather than a generic failure
 *  - Clear DELETEs the same address and wipes both the stored state and the typed inputs
 *  - the control degrades in two distinct, named ways when it cannot be used: no client saved
 *    yet, or storage unconfigured
 *  - the busy state disables the controls for the duration of the request
 *
 * @see components/admin/demo-clients/custom-font-field.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CustomFontField } from '@/components/admin/demo-clients/custom-font-field';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderField(overrides: Partial<Parameters<typeof CustomFontField>[0]> = {}) {
  const props = {
    demoClientId: 'client_1',
    uploadEnabled: true,
    initialDisplay: null,
    initialBody: null,
    ...overrides,
  };
  return render(<CustomFontField {...props} />);
}

const displayBox = () => screen.getByLabelText('Headings');
const bodyBox = () => screen.getByLabelText('Body text');
const loadButton = () => screen.getByRole('button', { name: /load these fonts/i });
const clearButton = () => screen.queryByRole('button', { name: /clear/i });

// ─── Prefill from the saved row ────────────────────────────────────────────────

describe('CustomFontField — prefill', () => {
  it('shows nothing stored and no Clear button when the client has no custom faces yet', () => {
    renderField();
    expect(displayBox()).toHaveValue('');
    expect(bodyBox()).toHaveValue('');
    expect(screen.queryByText(/^Stored:/)).not.toBeInTheDocument();
    expect(clearButton()).not.toBeInTheDocument();
  });

  it('reflects previously loaded families immediately, without a fetch', () => {
    renderField({ initialDisplay: 'Poppins', initialBody: 'Karla' });

    expect(displayBox()).toHaveValue('Poppins');
    expect(bodyBox()).toHaveValue('Karla');
    expect(screen.getByText(/Stored: Poppins and Karla/)).toBeInTheDocument();
    expect(clearButton()).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('joins just the one family set, when only a display face was loaded', () => {
    renderField({ initialDisplay: 'Poppins', initialBody: null });
    expect(screen.getByText(/Stored: Poppins\./)).toBeInTheDocument();
  });
});

// ─── When loading is unavailable ───────────────────────────────────────────────

describe('CustomFontField — when it cannot be used', () => {
  it('explains that the client must be saved first, on the create form', () => {
    renderField({ demoClientId: undefined });

    expect(screen.getByText(/save the client first/i)).toBeInTheDocument();
    expect(displayBox()).toBeDisabled();
    expect(loadButton()).toBeDisabled();
  });

  it('explains that storage is unconfigured, for a saved client', () => {
    renderField({ uploadEnabled: false });

    expect(screen.getByText(/file storage is not configured/i)).toBeInTheDocument();
    expect(screen.queryByText(/save the client first/i)).not.toBeInTheDocument();
    expect(displayBox()).toBeDisabled();
  });

  it('disables every control when the parent form disables the field', () => {
    renderField({ disabled: true, initialDisplay: 'Poppins', initialBody: 'Karla' });

    expect(displayBox()).toBeDisabled();
    expect(bodyBox()).toBeDisabled();
    expect(loadButton()).toBeDisabled();
    // Clear is offered (fonts are already loaded) but still disabled by the parent.
    expect(clearButton()).toBeDisabled();
  });

  it('keeps Load disabled until at least one family is typed', async () => {
    const user = userEvent.setup();
    renderField();

    expect(loadButton()).toBeDisabled();
    await user.type(displayBox(), 'Poppins');
    expect(loadButton()).toBeEnabled();
  });
});

// ─── Loading fonts ──────────────────────────────────────────────────────────────

describe('CustomFontField — load', () => {
  it('POSTs the trimmed families to the fonts endpoint and stores what comes back', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { display: 'Poppins', body: 'Karla', weights: { Poppins: [400, 700] } },
      })
    );
    const user = userEvent.setup();
    renderField();

    await user.type(displayBox(), '  Poppins  ');
    await user.type(bodyBox(), '  Karla  ');
    await user.click(loadButton());

    await waitFor(() => expect(screen.getByText(/Stored: Poppins and Karla/)).toBeInTheDocument());
    expect(screen.getByText(/weights 400, 700/)).toBeInTheDocument();
    expect(screen.getByText(/Set the pairing above to/)).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/v1/app/demo-clients/client_1/fonts');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ display: 'Poppins', body: 'Karla' });
  });

  it('dedupes and sorts weights pooled across both families', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          display: 'Poppins',
          body: 'Karla',
          weights: { Poppins: [700, 400], Karla: [400, 600] },
        },
      })
    );
    const user = userEvent.setup();
    renderField();
    await user.type(displayBox(), 'Poppins');
    await user.click(loadButton());

    expect(await screen.findByText(/weights 400, 600, 700/)).toBeInTheDocument();
  });

  it('shows the busy state while the request is in flight, then clears it', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const user = userEvent.setup();
    renderField();
    await user.type(displayBox(), 'Poppins');

    await user.click(loadButton());

    await waitFor(() => expect(loadButton()).toBeDisabled());
    expect(displayBox()).toBeDisabled();

    resolveFetch(
      jsonResponse({ success: true, data: { display: 'Poppins', body: null, weights: {} } })
    );

    await waitFor(() => expect(loadButton()).not.toBeDisabled());
  });

  it("surfaces the server's own rejection naming the bad family, not a generic failure", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'FONT_NOT_FOUND',
            message: 'Google Fonts has no family named "Not A Real Font"',
          },
        },
        400
      )
    );
    const user = userEvent.setup();
    renderField();

    await user.type(displayBox(), 'Not A Real Font');
    await user.click(loadButton());

    expect(await screen.findByText(/no family named "Not A Real Font"/)).toBeInTheDocument();
    // Nothing was adopted — no Stored line, no Clear button.
    expect(screen.queryByText(/^Stored:/)).not.toBeInTheDocument();
    expect(clearButton()).not.toBeInTheDocument();
  });

  it('accepts a family Google Fonts does recognise, the other side of that same boundary', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { display: 'IBM Plex Sans', body: null, weights: {} },
      })
    );
    const user = userEvent.setup();
    renderField();

    await user.type(displayBox(), 'IBM Plex Sans');
    await user.click(loadButton());

    expect(await screen.findByText(/Stored: IBM Plex Sans\./)).toBeInTheDocument();
  });

  it('reports a transport failure instead of leaving the control stuck busy', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    renderField();

    await user.type(displayBox(), 'Poppins');
    await user.click(loadButton());

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    await waitFor(() => expect(loadButton()).not.toBeDisabled());
  });

  it('does not touch fontPairing — the field has no callback into the surrounding form', async () => {
    // "Loading is not saving": the only contract this field has with its parent is the four
    // read-only props it was given. A successful load must not require, and cannot trigger,
    // any parent-side state change — it stores itself and waits for the pairing to be
    // switched to Custom independently.
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { display: 'Poppins', body: null, weights: {} },
      })
    );
    const user = userEvent.setup();
    const { rerender } = renderField();

    await user.type(displayBox(), 'Poppins');
    await user.click(loadButton());

    expect(await screen.findByText(/Stored: Poppins\./)).toBeInTheDocument();

    // Re-rendering with the same (unchanged) initial props — as the parent form would, since
    // it never learned of the load — leaves the loaded state exactly as it was.
    rerender(
      <CustomFontField
        demoClientId="client_1"
        uploadEnabled
        initialDisplay={null}
        initialBody={null}
      />
    );
    expect(screen.getByText(/Stored: Poppins\./)).toBeInTheDocument();
  });
});

// ─── Clearing fonts ─────────────────────────────────────────────────────────────

describe('CustomFontField — clear', () => {
  it('DELETEs the same address and resets both the stored state and the inputs', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: {} }));
    const user = userEvent.setup();
    renderField({ initialDisplay: 'Poppins', initialBody: 'Karla' });

    await user.click(clearButton() as HTMLElement);

    await waitFor(() => expect(screen.queryByText(/^Stored:/)).not.toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/app/demo-clients/client_1/fonts', {
      method: 'DELETE',
    });
    expect(displayBox()).toHaveValue('');
    expect(bodyBox()).toHaveValue('');
    expect(clearButton()).not.toBeInTheDocument();
  });

  it('reports a transport failure on clear without losing the stored state', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    renderField({ initialDisplay: 'Poppins', initialBody: 'Karla' });

    await user.click(clearButton() as HTMLElement);

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    // The optimistic reset only happens after a successful DELETE.
    expect(screen.getByText(/Stored: Poppins and Karla/)).toBeInTheDocument();
  });
});
