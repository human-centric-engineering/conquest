// @vitest-environment happy-dom

/**
 * BrandImportDialog component tests.
 *
 * Two entry points feed one result panel: a website address (JSON POST) or a screenshot
 * (multipart POST), both landing on `BrandImportResult`. The behaviours that matter:
 *
 *  - every proposal arrives pre-ticked; the admin's job is to veto, not re-select
 *  - Apply hands the parent only the ACCEPTED fields, as plain values
 *  - an accepted image is re-hosted via its own endpoint immediately (not handed back as a
 *    draft value) whenever a saved client + configured storage make that possible; otherwise
 *    the raw discovered URL is handed back like any other field, and the panel says so
 *  - a `custom` typeface similarly round-trips through its own endpoint before it is applied,
 *    and failure there drops just the three type fields rather than the whole apply
 *  - every outcome (`ok` / `partial` / `empty` / `blocked`) is a 200 with guidance, and a
 *    `blocked` website import always offers the screenshot tab as the next step
 *  - a non-ok response or a thrown error surfaces a message rather than throwing
 *
 * @see components/admin/demo-clients/brand-import-dialog.tsx
 * @see .context/app/questionnaire/brand-import.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrandImportDialog } from '@/components/admin/demo-clients/brand-import-dialog';
import type { BrandImportResult } from '@/lib/app/questionnaire/brand-import/result';
import {
  MAX_STORED_CANDIDATES,
  brandPaletteSchema,
} from '@/lib/app/questionnaire/brand-import/palette-record';

// ─── fetch mock ────────────────────────────────────────────────────────────────

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

// ─── fixtures ──────────────────────────────────────────────────────────────────

/**
 * A representative `ok` result: two colours (one high-confidence with no caveat, one
 * low-confidence with one) and a logo — enough to exercise every branch the proposal list
 * renders (colour swatch vs none, "best guess" badge, caveat line).
 */
function okResult(overrides: Partial<BrandImportResult> = {}): BrandImportResult {
  return {
    outcome: 'ok',
    source: 'url',
    fields: {
      ctaColor: { value: '#112233', confidence: 'high', source: 'The site declares this colour' },
      surfaceColor: {
        value: '#445566',
        confidence: 'low',
        source: 'Most common colour in the header',
        caveat: 'Low contrast against the ink colour',
      },
      logoUrl: {
        value: 'https://client.example.com/logo.png',
        confidence: 'high',
        source: 'schema.org logo',
      },
    },
    reason: null,
    nextStep: null,
    candidates: [
      { hex: '#334455', share: 0.42, neutral: false },
      { hex: '#f7f7f7', share: 0.31, neutral: true },
    ],
    degraded: false,
    ...overrides,
  };
}

/**
 * What `onApply`'s second argument should look like for {@link okResult}.
 *
 * `capturedAt` is stamped when the run RETURNS, so it is matched loosely — pinning it would test
 * the clock. What the assertions care about is that the measured colours and the provenance line
 * travel with the proposals they produced, in the same call.
 */
function expectedPalette(readFrom: string | null) {
  return {
    candidates: [
      { hex: '#334455', share: 0.42, neutral: false },
      { hex: '#f7f7f7', share: 0.31, neutral: true },
    ],
    readFrom,
    capturedAt: expect.any(String),
  };
}

/** An `ok` result proposing a custom type pairing plus one colour. */
function customFontResult(): BrandImportResult {
  return {
    outcome: 'ok',
    source: 'url',
    fields: {
      ctaColor: { value: '#112233', confidence: 'high', source: 'The site declares this colour' },
      fontPairing: { value: 'custom', confidence: 'low', source: "The site's own face" },
      customFontDisplay: {
        value: 'Sora',
        confidence: 'low',
        source: 'font-family stack',
        caveat: 'We will try to load this family from Google Fonts.',
      },
      customFontBody: { value: 'Sora', confidence: 'low', source: 'font-family stack' },
    },
    reason: null,
    nextStep: null,
    candidates: [],
    degraded: false,
  };
}

function blockedResult(reason = 'The site returned 403 Forbidden.'): BrandImportResult {
  return {
    outcome: 'blocked',
    source: 'url',
    fields: {},
    reason,
    nextStep: 'screenshot',
    candidates: [],
    degraded: false,
  };
}

// ─── render + interaction helpers ─────────────────────────────────────────────

function renderDialog(overrides: Partial<Parameters<typeof BrandImportDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onApply = vi.fn();
  const utils = render(
    <BrandImportDialog open onOpenChange={onOpenChange} onApply={onApply} {...overrides} />
  );
  return { ...utils, onOpenChange, onApply };
}

function addressBox() {
  return screen.getByRole('textbox', { name: 'Website address' });
}

function readButton() {
  return screen.getByRole('button', { name: /read the brand/i });
}

async function typeUrl(user: ReturnType<typeof userEvent.setup>, address: string) {
  await user.type(addressBox(), address);
}

async function importFromUrl(user: ReturnType<typeof userEvent.setup>, address = 'acme.example') {
  await typeUrl(user, address);
  await user.click(readButton());
}

/** Set up a dialog that has already imported the standard `okResult()`. */
async function setupWithOkResult(overrides: Partial<Parameters<typeof BrandImportDialog>[0]> = {}) {
  mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: okResult() }));
  const user = userEvent.setup();
  const rendered = renderDialog(overrides);
  await importFromUrl(user);
  await screen.findByText('What we found');
  return { user, ...rendered };
}

function screenshotFile(name = 'homepage.png') {
  return new File(['x'], name, { type: 'image/png' });
}

/** Stage a file. Picking no longer submits: an admin may be about to add an address too. */
async function pickScreenshot(...files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, files);
}

async function importFromFiles(user: ReturnType<typeof userEvent.setup>, ...files: File[]) {
  await pickScreenshot(...(files.length > 0 ? files : [screenshotFile()]));
  await user.click(readButton());
}

// ─── rendering ─────────────────────────────────────────────────────────────────

describe('BrandImportDialog — initial rendering', () => {
  it('offers both inputs at once, on one form, and no proposals yet', () => {
    // They were two tabs, which made "give us both" — the most reliable thing an admin can do —
    // the one combination the UI could not express.
    renderDialog();
    expect(screen.getByRole('textbox', { name: 'Website address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a screenshot/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('What we found')).not.toBeInTheDocument();
  });

  it('disables the import until there is something to read', () => {
    renderDialog();
    expect(readButton()).toBeDisabled();
  });

  it('enables the import on a screenshot alone, with no address typed', async () => {
    renderDialog();
    await pickScreenshot(screenshotFile());
    expect(readButton()).not.toBeDisabled();
  });
});

// ─── importing from a website address ─────────────────────────────────────────

describe('BrandImportDialog — importing from a website address', () => {
  it('POSTs the trimmed address as JSON and renders what came back', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog({ demoClientId: 'client-1' });

    await importFromUrl(user, '  acme.example  ');

    await screen.findByText('What we found');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/v1/app/demo-clients/brand-import');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'acme.example',
      demoClientId: 'client-1',
    });

    // The proposal list, rendered from what the route returned.
    expect(screen.getByText('CTA colour')).toBeInTheDocument();
    expect(screen.getByText('#112233')).toBeInTheDocument();
    expect(screen.getByText('Logo')).toBeInTheDocument();
  });

  it('does not call the API for a blank or whitespace-only address, even via Enter', async () => {
    const user = userEvent.setup();
    renderDialog();
    await typeUrl(user, '   {Enter}');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submits on Enter, not only via the button', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog();
    await typeUrl(user, 'acme.example{Enter}');
    await screen.findByText('What we found');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('disables the address field and swaps in a spinner while the request is in flight', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const user = userEvent.setup();
    renderDialog();
    await typeUrl(user, 'acme.example');
    await user.click(readButton());

    expect(addressBox()).toBeDisabled();
    expect(readButton()).toBeDisabled();

    await act(async () => {
      resolveFetch(jsonResponse({ success: true, data: okResult() }));
    });
    await waitFor(() => expect(addressBox()).not.toBeDisabled());
  });

  it('surfaces the route’s own rejection message rather than throwing', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many imports — wait a minute.' },
        },
        429
      )
    );
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many imports — wait a minute.');
    expect(screen.queryByText('What we found')).not.toBeInTheDocument();
  });

  it('surfaces a thrown Error’s message', async () => {
    mockFetch.mockRejectedValue(new Error('DNS lookup failed'));
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('DNS lookup failed');
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    mockFetch.mockRejectedValue('boom');
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read that website.');
  });
});

// ─── importing from a screenshot ──────────────────────────────────────────────

describe('BrandImportDialog — importing from screenshots', () => {
  it('POSTs the file as multipart, including demoClientId when the client is saved', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog({ demoClientId: 'client-1' });

    await importFromFiles(user);

    await screen.findByText('What we found');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/v1/app/demo-clients/brand-import');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    expect((init.body as FormData).get('demoClientId')).toBe('client-1');
  });

  it('omits demoClientId on the create form, where there is no client yet', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog();

    await importFromFiles(user);

    await screen.findByText('What we found');
    const [, init] = mockFetch.mock.calls[0];
    expect((init.body as FormData).get('demoClientId')).toBeNull();
  });

  it('clears the file input so re-picking the same file still fires a change', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog();

    await importFromFiles(user);
    await screen.findByText('What we found');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('disables the picker and swaps in a spinner while the request is in flight', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const user = userEvent.setup();
    renderDialog();
    await importFromFiles(user);

    expect(readButton()).toBeDisabled();

    await act(async () => {
      resolveFetch(jsonResponse({ success: true, data: okResult() }));
    });
    await waitFor(() => expect(readButton()).not.toBeDisabled());
  });

  it('surfaces the route’s own rejection message for a screenshot too', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'FILE_TOO_SMALL', message: 'Image is too small.' } },
        400
      )
    );
    const user = userEvent.setup();
    renderDialog();
    await importFromFiles(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Image is too small.');
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    mockFetch.mockRejectedValue('boom');
    const user = userEvent.setup();
    renderDialog();
    await importFromFiles(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read those screenshots.');
  });

  it('sends the address WITH the pictures, so one call sees both', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    renderDialog({ demoClientId: 'client-1' });

    await typeUrl(user, 'acme.example');
    await importFromFiles(user, screenshotFile('hero.png'), screenshotFile('pricing.png'));

    await screen.findByText('What we found');
    // One request, not one per source: the site and the pictures are evidence about one brand.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get('url')).toBe('acme.example');
    expect(body.getAll('file')).toHaveLength(2);
  });

  it('lists what has been added and lets one be removed before importing', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pickScreenshot(screenshotFile('hero.png'), screenshotFile('pricing.png'));
    expect(screen.getByText('hero.png')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove hero.png' }));

    expect(screen.queryByText('hero.png')).not.toBeInTheDocument();
    expect(screen.getByText('pricing.png')).toBeInTheDocument();
  });

  it('says it kept the first three rather than silently dropping the rest', async () => {
    renderDialog();

    await pickScreenshot(
      screenshotFile('a.png'),
      screenshotFile('b.png'),
      screenshotFile('c.png'),
      screenshotFile('d.png')
    );

    // Quietly keeping three of four looks exactly like an import that ignored a picture.
    expect(await screen.findByRole('alert')).toHaveTextContent('we kept the first 3');
    expect(screen.queryByText('d.png')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a screenshot/i })).toBeDisabled();
  });
});

// ─── the failure contract: outcomes and next steps ────────────────────────────

describe('BrandImportDialog — outcome guidance', () => {
  it('points a blocked website import at a screenshot, keeping the address it already has', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: blockedResult() }));
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);

    expect(await screen.findByText('The site returned 403 Forbidden.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a screenshot instead/i })).toBeInTheDocument();

    // The address stays put: adding a picture is a second source for the same import, not a
    // restart of it, and re-typing the address would be busywork.
    await pickScreenshot(screenshotFile());
    await user.click(screen.getByRole('button', { name: /read the brand/i }));

    const [, init] = mockFetch.mock.calls[1];
    expect((init.body as FormData).get('url')).toBe('acme.example');
  });

  it('resets the shown result when Radix itself dismisses the dialog (Escape), unlike Cancel', async () => {
    // The outer <Dialog onOpenChange> wrapper calls reset() only for a dismissal Radix
    // initiates (Escape, outside click, the X button) — not for the footer's own Cancel,
    // which reports straight to the parent. Escape is the one this test can drive directly.
    const { user, onOpenChange } = await setupWithOkResult();

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('What we found')).not.toBeInTheDocument();
  });

  it('does not offer a screenshot when the run already had one', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: blockedResult() }));
    const user = userEvent.setup();
    renderDialog();
    await importFromFiles(user);

    expect(await screen.findByText('The site returned 403 Forbidden.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /add a screenshot instead/i })
    ).not.toBeInTheDocument();
  });

  it('renders a non-blocked reason (partial/empty) without a next-step button when there is none', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          outcome: 'partial',
          source: 'url',
          fields: { ctaColor: { value: '#112233', confidence: 'high', source: 'declared' } },
          reason: 'We could only work out one field from that page. Set the rest by hand.',
          nextStep: 'manual',
          candidates: [],
          degraded: false,
        },
      })
    );
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);

    expect(
      await screen.findByText(
        'We could only work out one field from that page. Set the rest by hand.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /try a screenshot instead/i })
    ).not.toBeInTheDocument();
  });
});

// ─── the proposal list: pre-ticked, per-field accept ──────────────────────────

describe('BrandImportDialog — proposal list', () => {
  it('pre-ticks every proposal, and shows the low-confidence badge and caveat only where present', async () => {
    await setupWithOkResult();

    expect(screen.getByRole('checkbox', { name: 'Apply CTA colour' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Apply Surface colour' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Apply Logo' })).toBeChecked();

    expect(screen.getByText('· best guess')).toBeInTheDocument(); // surfaceColor only
    expect(screen.getByText('Low contrast against the ink colour')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Apply 3 fields' })).toBeInTheDocument();
  });

  it('un-ticking a proposal drops it from what Apply would send, and updates the count/label', async () => {
    const { user, onApply } = await setupWithOkResult();

    await user.click(screen.getByRole('checkbox', { name: 'Apply Logo' }));
    await user.click(screen.getByRole('checkbox', { name: 'Apply Surface colour' }));

    expect(screen.getByRole('button', { name: 'Apply 1 field' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply 1 field' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith({ ctaColor: '#112233' }, expectedPalette('acme.example'));
  });

  it('re-ticking a proposal restores it to what Apply would send', async () => {
    const { user, onApply } = await setupWithOkResult();

    const logoCheckbox = screen.getByRole('checkbox', { name: 'Apply Logo' });
    await user.click(logoCheckbox); // off
    await user.click(logoCheckbox); // back on

    expect(screen.getByRole('button', { name: 'Apply 3 fields' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ logoUrl: 'https://client.example.com/logo.png' }),
      expectedPalette('acme.example')
    );
  });

  it('disables Apply once every proposal is un-ticked', async () => {
    const { user } = await setupWithOkResult();

    await user.click(screen.getByRole('checkbox', { name: 'Apply CTA colour' }));
    await user.click(screen.getByRole('checkbox', { name: 'Apply Surface colour' }));
    await user.click(screen.getByRole('checkbox', { name: 'Apply Logo' }));

    expect(screen.getByRole('button', { name: /^Apply\s*fields$/ })).toBeDisabled();
  });

  it('renders every measured colour in the palette strip', async () => {
    await setupWithOkResult();

    expect(screen.getByText('Every colour we measured')).toBeInTheDocument();
    expect(screen.getByText('#334455')).toBeInTheDocument();
    expect(screen.getByText('#f7f7f7')).toBeInTheDocument();
  });

  it('omits the palette strip when nothing was measured', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: blockedResult() }));
    const user = userEvent.setup();
    renderDialog();
    await importFromUrl(user);
    await screen.findByRole('status');
    expect(screen.queryByText('Every colour we measured')).not.toBeInTheDocument();
  });
});

// ─── applying accepted fields ──────────────────────────────────────────────────

describe('BrandImportDialog — applying plain (non-image, non-font) fields', () => {
  it('applies the accepted colours literally, closes and resets', async () => {
    const { user, onApply, onOpenChange } = await setupWithOkResult();
    // demoClientId absent → logoUrl cannot be re-hosted, so it is handed back literally too.
    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      {
        ctaColor: '#112233',
        surfaceColor: '#445566',
        logoUrl: 'https://client.example.com/logo.png',
      },
      expectedPalette('acme.example')
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // reset() ran: the proposal panel is gone.
    expect(screen.queryByText('What we found')).not.toBeInTheDocument();
  });

  it('warns that a logo would be hotlinked for a saved client with no storage configured', async () => {
    await setupWithOkResult({ demoClientId: 'client-1', uploadEnabled: false });
    expect(
      screen.getByText(/file storage is not configured, so images will be linked/i)
    ).toBeInTheDocument();
  });

  it('tells the create form to save first before a logo can be re-hosted', async () => {
    await setupWithOkResult();
    expect(screen.getByText(/save the client first and re-run the import/i)).toBeInTheDocument();
  });

  it('shows neither storage message once re-hosting is available', async () => {
    await setupWithOkResult({ demoClientId: 'client-1', uploadEnabled: true });
    expect(
      screen.queryByText(/file storage is not configured, so images will be linked/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/save the client first and re-run the import/i)
    ).not.toBeInTheDocument();
  });
});

describe('BrandImportDialog — re-hosting an accepted image', () => {
  it('re-hosts the logo via its own endpoint and applies the URL it returns', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/app/demo-clients/brand-import') {
        return Promise.resolve(jsonResponse({ success: true, data: okResult() }));
      }
      if (url === '/api/v1/app/demo-clients/client-1/logo') {
        return Promise.resolve(
          jsonResponse({ success: true, data: { url: '/uploads/demo-clients/client-1/logo.png' } })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const { onApply } = renderDialog({ demoClientId: 'client-1', uploadEnabled: true });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      {
        ctaColor: '#112233',
        surfaceColor: '#445566',
        logoUrl: '/uploads/demo-clients/client-1/logo.png',
      },
      expectedPalette('acme.example')
    );

    const rehostCall = mockFetch.mock.calls.find(
      ([url]) => url === '/api/v1/app/demo-clients/client-1/logo'
    );
    expect(rehostCall).toBeDefined();
    const [, init] = rehostCall as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      sourceUrl: 'https://client.example.com/logo.png',
    });
  });

  it('falls back to the discovered URL when re-hosting fails, rather than dropping the logo', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/app/demo-clients/brand-import') {
        return Promise.resolve(jsonResponse({ success: true, data: okResult() }));
      }
      if (url === '/api/v1/app/demo-clients/client-1/logo') {
        return Promise.reject(new Error('CDN refused the request'));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const { onApply } = renderDialog({ demoClientId: 'client-1', uploadEnabled: true });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ logoUrl: 'https://client.example.com/logo.png' }),
      expectedPalette('acme.example')
    );
  });
});

// ─── the measured palette rides with the proposals ────────────────────────────

describe('BrandImportDialog — the measured palette', () => {
  it('names the address alone as the source when no screenshot was added', async () => {
    const { user, onApply } = await setupWithOkResult();

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toMatchObject({ readFrom: 'acme.example' });
  });

  it('names both halves when the admin gave an address and screenshots', async () => {
    // The combination the import prefers, and the one the strip should be able to say it used —
    // an admin looking at a palette weeks later cannot otherwise tell what evidence produced it.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: okResult() }));
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await typeUrl(user, 'acme.example');
    await pickScreenshot(screenshotFile('home.png'), screenshotFile('pricing.png'));
    await user.click(readButton());
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toMatchObject({
      readFrom: 'acme.example + 2 screenshots',
    });
  });

  it('carries the palette even when the admin vetoes every colour proposal', async () => {
    // The palette is evidence about the SITE, not about the fields accepted from it. Dropping it
    // when the admin re-types the colours by hand would throw away the measurement they are
    // typing FROM.
    const { user, onApply } = await setupWithOkResult();

    await user.click(screen.getByRole('checkbox', { name: 'Apply CTA colour' }));
    await user.click(screen.getByRole('checkbox', { name: 'Apply Surface colour' }));
    await user.click(screen.getByRole('button', { name: 'Apply 1 field' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toMatchObject({
      candidates: [
        { hex: '#334455', share: 0.42, neutral: false },
        { hex: '#f7f7f7', share: 0.31, neutral: true },
      ],
    });
  });

  it('stamps capturedAt as an ISO timestamp the write boundary will accept', async () => {
    const { user, onApply } = await setupWithOkResult();

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const palette = onApply.mock.calls[0][1] as { capturedAt: string };
    expect(brandPaletteSchema.safeParse(onApply.mock.calls[0][1]).success).toBe(true);
    expect(Number.isNaN(Date.parse(palette.capturedAt))).toBe(false);
  });

  it('caps what it hands back at the number the column will store', async () => {
    // A merged run over a site plus three screenshots can return more candidates than we keep.
    // Posting a body the API would reject fails the whole save over the least important thing in
    // it, so the cap is applied here as well as at the write boundary.
    const tooMany = Array.from({ length: MAX_STORED_CANDIDATES + 4 }, (_, i) => ({
      hex: `#0000${i.toString(16).padStart(2, '0')}`,
      share: 0.01,
      neutral: false,
    }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: okResult({ candidates: tooMany }) })
    );
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const palette = onApply.mock.calls[0][1] as { candidates: unknown[] };
    expect(palette.candidates).toHaveLength(MAX_STORED_CANDIDATES);
    expect(brandPaletteSchema.safeParse(palette).success).toBe(true);
  });

  it('hands back null when the run measured nothing, clearing a stale palette', async () => {
    // A blocked site produces no candidates. Leaving the previous strip in place beside colours
    // this run did not read would attribute them to evidence we never gathered.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: okResult({ candidates: [] }) })
    );
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: 'Apply 3 fields' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toBeNull();
  });
});

// ─── custom typefaces: an immediate write, not a draft value ──────────────────

describe('BrandImportDialog — custom typefaces', () => {
  it('loads and applies the families, then closes — a clean apply has nothing to say', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/app/demo-clients/brand-import') {
        return Promise.resolve(jsonResponse({ success: true, data: customFontResult() }));
      }
      if (url === '/api/v1/app/demo-clients/client-1/fonts') {
        return Promise.resolve(jsonResponse({ success: true, data: { ok: true } }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const { onApply, onOpenChange } = renderDialog({
      demoClientId: 'client-1',
      uploadEnabled: true,
    });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: /^Apply \d+ fields$/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      {
        ctaColor: '#112233',
        fontPairing: 'custom',
        customFontDisplay: 'Sora',
        customFontBody: 'Sora',
      },
      null
    );
    const fontsCall = mockFetch.mock.calls.find(
      ([url]) => url === '/api/v1/app/demo-clients/client-1/fonts'
    );
    expect(fontsCall).toBeDefined();
    const [, init] = fontsCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ display: 'Sora', body: 'Sora' });
    // The dialog stays open only when there is a MESSAGE to read. On the success path there is
    // none, and leaving it open gave the admin no cue but the absence of a close — which reads as
    // "it did not work" and invites a second Apply, re-running the re-host and the fonts fetch.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/Everything else was applied/)).not.toBeInTheDocument();
  });

  it('drops just the type fields and explains why when loading the families fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/app/demo-clients/brand-import') {
        return Promise.resolve(jsonResponse({ success: true, data: customFontResult() }));
      }
      if (url === '/api/v1/app/demo-clients/client-1/fonts') {
        return Promise.resolve(
          jsonResponse(
            {
              success: false,
              error: { code: 'FONT_NOT_FOUND', message: 'Sora was not found on Google Fonts.' },
            },
            404
          )
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const { onApply } = renderDialog({ demoClientId: 'client-1', uploadEnabled: true });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: /^Apply \d+ fields$/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    // fontPairing was 'custom' and got deleted alongside the two family fields.
    expect(onApply).toHaveBeenCalledWith(
      { ctaColor: '#112233' },
      // `customFontResult()` measured no colours, so there is no palette to keep — and a null
      // clears whatever the client had rather than leaving an older strip beside new colours.
      null
    );
    expect(
      await screen.findByText(/sora was not found on google fonts\. everything else was applied/i)
    ).toBeInTheDocument();
  });

  it('falls back to a generic message when the font request itself throws a non-Error', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/app/demo-clients/brand-import') {
        return Promise.resolve(jsonResponse({ success: true, data: customFontResult() }));
      }
      if (url === '/api/v1/app/demo-clients/client-1/fonts') {
        // Deliberately a non-Error rejection: this test exists to pin the `err instanceof
        // Error ? ... : 'Could not load those typefaces.'` fallback branch in `loadFonts`.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject('boom');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const { onApply } = renderDialog({ demoClientId: 'client-1', uploadEnabled: true });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: /^Apply \d+ fields$/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      { ctaColor: '#112233' },
      // `customFontResult()` measured no colours, so there is no palette to keep — and a null
      // clears whatever the client had rather than leaving an older strip beside new colours.
      null
    );
    expect(
      await screen.findByText(/could not load those typefaces\. everything else was applied/i)
    ).toBeInTheDocument();
  });

  it('drops the type fields with a storage-unconfigured message for a saved client', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: customFontResult() }));
    const user = userEvent.setup();
    const { onApply } = renderDialog({ demoClientId: 'client-1', uploadEnabled: false });
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: /^Apply \d+ fields$/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      { ctaColor: '#112233' },
      // `customFontResult()` measured no colours, so there is no palette to keep — and a null
      // clears whatever the client had rather than leaving an older strip beside new colours.
      null
    );
    expect(
      await screen.findByText(
        /file storage is not configured, so custom typefaces could not be stored/i
      )
    ).toBeInTheDocument();
  });

  it('tells the create form to save first before typefaces can be stored', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: customFontResult() }));
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await importFromUrl(user);
    await screen.findByText('What we found');

    await user.click(screen.getByRole('button', { name: /^Apply \d+ fields$/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(
      { ctaColor: '#112233' },
      // `customFontResult()` measured no colours, so there is no palette to keep — and a null
      // clears whatever the client had rather than leaving an older strip beside new colours.
      null
    );
    expect(
      await screen.findByText(/save the client first to store its typefaces/i)
    ).toBeInTheDocument();
  });
});

// ─── cancel ─────────────────────────────────────────────────────────────────────

describe('BrandImportDialog — cancel', () => {
  it('reports the intent to close without applying anything', async () => {
    const { onOpenChange, onApply } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onApply).not.toHaveBeenCalled();
  });
});
