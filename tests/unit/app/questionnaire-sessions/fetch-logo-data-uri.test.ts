import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { fetchLogoDataUri } from '@/app/api/v1/app/questionnaire-sessions/_lib/fetch-logo-data-uri';

function res(opts: { ok?: boolean; contentType?: string; body?: Uint8Array }): Response {
  return {
    ok: opts.ok ?? true,
    headers: new Headers(opts.contentType ? { 'content-type': opts.contentType } : {}),
    arrayBuffer: async () => (opts.body ?? new Uint8Array([1, 2, 3, 4])).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLogoDataUri', () => {
  it('returns a base64 data URI for an ok https image response within the size cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ contentType: 'image/png' })));
    const uri = await fetchLogoDataUri('https://cdn.example/logo.png');
    expect(uri).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`);
  });

  it('strips MIME parameters from the media-type so the data URI stays conformant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ contentType: 'image/svg+xml; charset=utf-8' }))
    );
    const uri = await fetchLogoDataUri('https://cdn.example/logo.svg');
    expect(uri).toBe(`data:image/svg+xml;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`);
  });

  it('returns null for a non-https URL without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLogoDataUri('http://insecure.example/logo.png')).toBeNull();
    expect(await fetchLogoDataUri(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ ok: false, contentType: 'image/png' })));
    expect(await fetchLogoDataUri('https://cdn.example/missing.png')).toBeNull();
  });

  it('returns null when the content-type is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ contentType: 'text/html' })));
    expect(await fetchLogoDataUri('https://cdn.example/page.html')).toBeNull();
  });

  it('returns null when the image exceeds the 1MB cap', async () => {
    const huge = new Uint8Array(1_000_001);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ contentType: 'image/png', body: huge }))
    );
    expect(await fetchLogoDataUri('https://cdn.example/huge.png')).toBeNull();
  });

  it('returns null when an empty body is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ contentType: 'image/png', body: new Uint8Array(0) }))
    );
    expect(await fetchLogoDataUri('https://cdn.example/empty.png')).toBeNull();
  });

  it('returns null (not throw) when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('aborted')));
    expect(await fetchLogoDataUri('https://cdn.example/slow.png')).toBeNull();
  });
});
