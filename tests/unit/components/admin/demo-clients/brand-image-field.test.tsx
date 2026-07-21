/**
 * BrandImageField component tests.
 *
 * The control is "link a URL or upload a file" over ONE value, with the two paths
 * differing in when they persist. The behaviours that matter:
 *  - upload is only offered when storage is configured AND the client is saved (the
 *    upload key is `demo-clients/<id>/…`, so a create form has nothing to attach to),
 *    and the disabled reason is shown rather than silently hidden
 *  - dimensions are pre-flighted in the BROWSER against the same spec the server
 *    enforces, so a wrong-sized export is rejected without a round-trip
 *  - a server rejection surfaces its own message verbatim, not a generic failure
 *  - Remove always calls DELETE when upload is available: only the LOCAL provider
 *    returns `/uploads/...`, so a path-prefix check for "one of ours" would skip
 *    cleanup on every S3 / Vercel Blob deployment
 *  - the copy tells the admin an upload applies immediately, unlike every other field
 *  - the banner and logo specs route to their own endpoints
 *
 * @see components/admin/demo-clients/brand-image-field.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrandImageField } from '@/components/admin/demo-clients/brand-image-field';
import { BRAND_BANNER_SPEC, BRAND_LOGO_SPEC } from '@/lib/app/questionnaire/theming';

// ─── Stub the browser image decoder ───────────────────────────────────────────
// `measure()` loads the File through an Image element, which jsdom cannot decode.
// Drive it from a mutable size so each test states the dimensions it is exercising.

let nextImageSize: { width: number; height: number } | null = { width: 1600, height: 400 };

class StubImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    // Fire asynchronously, as a real decode would.
    queueMicrotask(() => {
      if (nextImageSize === null) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = nextImageSize.width;
      this.naturalHeight = nextImageSize.height;
      this.onload?.();
    });
  }
}

const mockFetch = vi.fn();

beforeEach(() => {
  nextImageSize = { width: 1600, height: 400 };
  mockFetch.mockReset();
  vi.stubGlobal('Image', StubImage);
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn(),
  });
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

function renderField(overrides: Partial<Parameters<typeof BrandImageField>[0]> = {}) {
  const onChange = vi.fn();
  const props = {
    id: 'bannerUrl',
    label: 'Banner',
    spec: BRAND_BANNER_SPEC,
    demoClientId: 'client_1',
    uploadEnabled: true,
    value: '',
    onChange,
    help: 'Banner help',
    ...overrides,
  };
  const utils = render(<BrandImageField {...props} />);
  return { ...utils, onChange };
}

/** A stand-in upload. Content is irrelevant — `measure()` is stubbed above. */
function imageFile(name = 'banner.png') {
  return new File(['x'], name, { type: 'image/png' });
}

async function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
}

// ─── Upload availability ──────────────────────────────────────────────────────

describe('BrandImageField — when upload is offered', () => {
  it('offers upload once storage is configured and the client is saved', () => {
    renderField();
    expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument();
  });

  it('withholds upload on the create form and says why', () => {
    renderField({ demoClientId: undefined });
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    expect(screen.getByText(/save the client first/i)).toBeInTheDocument();
  });

  it('withholds upload when storage is unconfigured and points at the URL field', () => {
    renderField({ uploadEnabled: false });
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    expect(screen.getByText(/uploads are not configured/i)).toBeInTheDocument();
  });

  it('states the banner ratio in the hint so the admin can export correctly', () => {
    renderField();
    expect(screen.getByText(/1600x400px recommended \(4:1, min 800x200\)/)).toBeInTheDocument();
  });

  it('states only a size range for a logo, which accepts any shape', () => {
    renderField({ spec: BRAND_LOGO_SPEC, label: 'Logo', id: 'logoUrl' });
    expect(screen.getByText(/up to 1200x1200px, min 80x40/i)).toBeInTheDocument();
  });

  it('warns that an upload persists at once, unlike a typed URL', () => {
    // An upload writes the column server-side; Cancel cannot undo it. The admin has to be
    // told, because every other field on this form is draft state until save.
    renderField();
    expect(screen.getByText(/uploads apply immediately/i)).toBeInTheDocument();
  });
});

// ─── The URL entry path ───────────────────────────────────────────────────────

describe('BrandImageField — URL entry', () => {
  it('reports typed input straight to the parent, which owns the value', async () => {
    const { onChange } = renderField();
    await userEvent.type(screen.getByRole('textbox'), 'h');
    expect(onChange).toHaveBeenCalledWith('h');
  });

  it('shows the parent-supplied validation error', () => {
    renderField({ error: 'Absolute https:// URL or an uploaded image (or leave blank)' });
    expect(screen.getByText(/absolute https:\/\/ url or an uploaded image/i)).toBeInTheDocument();
  });
});

// ─── Client-side dimension pre-flight ─────────────────────────────────────────

describe('BrandImageField — dimension pre-flight', () => {
  it('rejects a wrong-shaped banner without hitting the network', async () => {
    nextImageSize = { width: 1600, height: 900 }; // 16:9 hero, not 4:1
    const { onChange } = renderField();

    await pickFile(imageFile());

    expect(await screen.findByText(/must be roughly 4:1/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an undersized image and echoes the measurement', async () => {
    nextImageSize = { width: 400, height: 100 };
    renderField();

    await pickFile(imageFile());

    expect(await screen.findByText(/at least 800x200px — this image is 400x100px/i)).toBeVisible();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a file that cannot be decoded as an image at all', async () => {
    // Passes the `accept` filter on its declared MIME but fails to decode — a truncated
    // or mislabelled file, which is exactly what the server's magic-byte check catches.
    nextImageSize = null;
    renderField();

    await pickFile(imageFile('corrupt.png'));

    expect(await screen.findByText(/could not be read as an image/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Upload ───────────────────────────────────────────────────────────────────

describe('BrandImageField — upload', () => {
  it('POSTs the file as multipart to the banner endpoint and adopts the returned URL', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { url: '/uploads/demo-clients/client_1/banner.jpg?v=1' },
      })
    );
    const { onChange } = renderField();

    await pickFile(imageFile());

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith('/uploads/demo-clients/client_1/banner.jpg?v=1')
    );
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/v1/app/demo-clients/client_1/banner');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('routes a logo to the logo endpoint, not the banner one', async () => {
    nextImageSize = { width: 600, height: 200 };
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { url: '/uploads/l.png' } }));
    renderField({ spec: BRAND_LOGO_SPEC, label: 'Logo', id: 'logoUrl' });

    await pickFile(imageFile('logo.png'));

    await waitFor(() =>
      expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/app/demo-clients/client_1/logo')
    );
  });

  it("surfaces the server's own rejection reason rather than a generic failure", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'STORAGE_NOT_CONFIGURED',
            message: 'File uploads are not configured — use an image URL instead',
          },
        },
        503
      )
    );
    const { onChange } = renderField();

    await pickFile(imageFile());

    expect(await screen.findByText(/use an image url instead/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a transport failure instead of leaving the control stuck busy', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    renderField();

    await pickFile(imageFile());

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /upload/i })).not.toBeDisabled());
  });

  it('clears the file input so re-picking the same file fires another change', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { url: '/uploads/b.jpg' } }));
    renderField();

    await pickFile(imageFile());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(''));
  });
});

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('BrandImageField — remove', () => {
  it('is offered only once a value is set', () => {
    const { rerender } = renderField();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();

    rerender(
      <BrandImageField
        id="bannerUrl"
        label="Banner"
        spec={BRAND_BANNER_SPEC}
        demoClientId="client_1"
        uploadEnabled
        value="/uploads/b.jpg"
        onChange={vi.fn()}
        help="Banner help"
      />
    );
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('DELETEs the stored object when the value is one of our uploads', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { success: true } }));
    const { onChange } = renderField({ value: '/uploads/demo-clients/client_1/banner.jpg?v=1' });

    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onChange).toHaveBeenCalledWith('');
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/app/demo-clients/client_1/banner', {
        method: 'DELETE',
      })
    );
  });

  it('DELETEs for an absolute URL too — S3 uploads are indistinguishable from typed ones', async () => {
    // Only the LOCAL provider returns `/uploads/...`; S3 and Vercel Blob return absolute
    // https URLs. Gating cleanup on the path prefix skipped it on every real deployment.
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { success: true } }));
    const { onChange } = renderField({ value: 'https://bucket.s3.amazonaws.com/banner.jpg' });

    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onChange).toHaveBeenCalledWith('');
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/app/demo-clients/client_1/banner', {
        method: 'DELETE',
      })
    );
  });

  it('skips the server call entirely when upload is unavailable', async () => {
    // No storage provider (or an unsaved client) → there is no object to clean up and no
    // id to address, so the parent's PATCH clearing the column is the whole story.
    const { onChange } = renderField({ uploadEnabled: false, value: 'https://a.example/b.jpg' });

    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onChange).toHaveBeenCalledWith('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still clears the value when the DELETE call fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    const { onChange } = renderField({ value: '/uploads/b.jpg' });

    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onChange).toHaveBeenCalledWith('');
    await waitFor(() => expect(screen.getByRole('button', { name: /remove/i })).not.toBeDisabled());
  });
});
