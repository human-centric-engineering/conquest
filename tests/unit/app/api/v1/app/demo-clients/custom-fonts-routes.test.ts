/**
 * Unit tests: the custom-font endpoints.
 *
 * Two routes with opposite audiences. The loader is admin-only and reaches out to a third party,
 * so it answers to the same sub-cap as the brand import. The server is unauthenticated — a
 * respondent answering a questionnaire is often not logged in, so the surface's assets cannot be —
 * and its whole job is to refuse anything it did not write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const limiterMock = vi.hoisted(() => ({
  brandImportLimiter: { check: vi.fn(() => ({ success: true, reset: 0 })) },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => limiterMock);

const prismaMock = vi.hoisted(() => ({
  appDemoClient: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const storageMock = vi.hoisted(() => ({
  getStorageClient: vi.fn(),
  isStorageEnabled: vi.fn(() => true),
}));
vi.mock('@/lib/storage/client', () => storageMock);
vi.mock('@/lib/storage/upload', () => ({ deleteByPrefix: vi.fn() }));

const fontsMock = vi.hoisted(() => ({ fetchGoogleFontFaces: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import/google-fonts', () => fontsMock);

import { POST, DELETE } from '@/app/api/v1/app/demo-clients/[id]/fonts/route';
import { GET } from '@/app/api/v1/app/demo-clients/[id]/font/[face]/route';

type AdminHandler = (
  request: Request,
  session: unknown,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response>;

const post = POST as unknown as AdminHandler;
const del = DELETE as unknown as AdminHandler;

const SESSION = { user: { id: 'admin-1' } };
const ctx = { params: Promise.resolve({ id: 'dc-1' }) };

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/fonts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const uploadMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  limiterMock.brandImportLimiter.check.mockReturnValue({ success: true, reset: 0 });
  storageMock.isStorageEnabled.mockReturnValue(true);
  // `storage.upload(buffer, options)` — the key is on the SECOND argument.
  uploadMock.mockImplementation(async (_buffer: Buffer, { key }: { key: string }) => ({
    key,
    url: `https://blob.example/${key}`,
    size: 100,
  }));
  storageMock.getStorageClient.mockReturnValue({ upload: uploadMock });
  prismaMock.appDemoClient.findUnique.mockResolvedValue({
    id: 'dc-1',
    name: 'Acme',
    customFontDisplay: null,
    customFontBody: null,
    customFontFiles: null,
  });
  prismaMock.appDemoClient.update.mockResolvedValue({ id: 'dc-1' });
  fontsMock.fetchGoogleFontFaces.mockResolvedValue({
    ok: true,
    faces: [
      { weight: 400, buffer: Buffer.from('a') },
      { weight: 700, buffer: Buffer.from('b') },
    ],
  });
});

describe('POST .../fonts', () => {
  it('stores every fetched weight under a fixed per-slot key', async () => {
    const response = await post(jsonRequest({ display: 'Poppins' }), SESSION, ctx);

    expect(response.status).toBe(200);
    // Fixed keys, so re-loading a family overwrites rather than accumulating orphans.
    expect(uploadMock.mock.calls.map((c) => c[1].key)).toEqual([
      'demo-clients/dc-1/fonts/display-400.woff2',
      'demo-clients/dc-1/fonts/display-700.woff2',
    ]);
  });

  it('writes the families and the file map, but never the pairing', async () => {
    await post(jsonRequest({ display: 'Poppins', body: 'Karla' }), SESSION, ctx);

    const data = prismaMock.appDemoClient.update.mock.calls[0][0].data;
    expect(data.customFontDisplay).toBe('Poppins');
    expect(data.customFontBody).toBe('Karla');
    expect(data.customFontFiles.display['400']).toBe(
      'https://blob.example/demo-clients/dc-1/fonts/display-400.woff2'
    );
    // `fontPairing` stays an ordinary form field — loading faces must not silently change the
    // questionnaire's type, and switching the picker away and back must not re-fetch Google.
    expect(data).not.toHaveProperty('fontPairing');
  });

  /**
   * A POST is routinely PARTIAL, so it merges rather than replaces.
   *
   * The import dialog sends only the families still ticked, and the field's own Load button sends
   * only the ones typed. Writing `loaded.body ?? null` therefore cleared a body face the client
   * already had — silently, and orphaning its stored objects, since nothing deletes the old prefix
   * on POST. Clearing is what DELETE is for.
   */
  it('leaves a slot this request did not name exactly as it was', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme',
      customFontDisplay: 'Sora',
      customFontBody: 'Karla',
      customFontFiles: {
        display: { '400': 'https://blob.example/old-display-400.woff2' },
        body: { '400': 'https://blob.example/old-body-400.woff2' },
      },
    });

    await post(jsonRequest({ display: 'Poppins' }), SESSION, ctx);

    const data = prismaMock.appDemoClient.update.mock.calls[0][0].data;
    expect(data.customFontDisplay).toBe('Poppins');
    expect(data.customFontBody).toBe('Karla');
    // The untouched slot keeps the files it already had; only `display` is rewritten.
    expect(data.customFontFiles.body).toEqual({
      '400': 'https://blob.example/old-body-400.woff2',
    });
    expect(data.customFontFiles.display['400']).toBe(
      'https://blob.example/demo-clients/dc-1/fonts/display-400.woff2'
    );
  });

  it('reports the merged state back, not just the slot it loaded', async () => {
    // The field renders this straight into its "Stored:" line. Echoing only what was loaded would
    // tell the admin the untouched slot had been cleared when it had not.
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme',
      customFontDisplay: null,
      customFontBody: 'Karla',
      customFontFiles: { body: { '400': 'https://blob.example/old-body-400.woff2' } },
    });

    const response = await post(jsonRequest({ display: 'Poppins' }), SESSION, ctx);
    const payload = await response.json();

    expect(payload.data.display).toBe('Poppins');
    expect(payload.data.body).toBe('Karla');
    expect(payload.data.weights.body).toEqual([400]);
  });

  it('refuses a family name that could reach a different URL', async () => {
    await expect(post(jsonRequest({ display: 'Inter&text=x' }), SESSION, ctx)).rejects.toThrow(
      'not a font name'
    );
    expect(fontsMock.fetchGoogleFontFaces).not.toHaveBeenCalled();
  });

  it('refuses a request naming no typeface at all', async () => {
    await expect(post(jsonRequest({}), SESSION, ctx)).rejects.toThrow('at least one typeface');
  });

  it('surfaces a family that does not exist as a 400 naming it', async () => {
    // There is no offline catalogue — asking Google is both the check and the fetch.
    fontsMock.fetchGoogleFontFaces.mockResolvedValue({
      ok: false,
      reason: 'We could not find “Notafont” on Google Fonts.',
    });

    await expect(post(jsonRequest({ display: 'Notafont' }), SESSION, ctx)).rejects.toThrow(
      'Notafont'
    );
    expect(prismaMock.appDemoClient.update).not.toHaveBeenCalled();
  });

  it('refuses when storage is unconfigured, rather than fetching for nowhere to put it', async () => {
    storageMock.isStorageEnabled.mockReturnValue(false);

    await expect(post(jsonRequest({ display: 'Poppins' }), SESSION, ctx)).rejects.toThrow(
      'storage is not configured'
    );
    expect(fontsMock.fetchGoogleFontFaces).not.toHaveBeenCalled();
  });

  it('applies the outbound sub-cap before doing any work', async () => {
    limiterMock.brandImportLimiter.check.mockReturnValue({ success: false, reset: 1 });

    const response = await post(jsonRequest({ display: 'Poppins' }), SESSION, ctx);

    expect(response.status).toBe(429);
    expect(fontsMock.fetchGoogleFontFaces).not.toHaveBeenCalled();
  });
});

describe('DELETE .../fonts', () => {
  it('clears the columns with DbNull, which is what a nullable Json column needs', async () => {
    const request = new Request('http://localhost/api/v1/app/demo-clients/dc-1/fonts', {
      method: 'DELETE',
    });

    await del(request, SESSION, ctx);

    const data = prismaMock.appDemoClient.update.mock.calls[0][0].data;
    expect(data.customFontDisplay).toBeNull();
    // A bare `null` is ambiguous between SQL NULL and the JSON value `null`, so Prisma refuses it.
    expect(data.customFontFiles).not.toBeNull();
  });
});

describe('GET .../font/:face', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      customFontFiles: { display: { '400': 'https://blob.example/d400.woff2' } },
    });
  });

  const get = (face: string) =>
    GET(new Request('http://localhost/'), {
      params: Promise.resolve({ id: 'dc-1', face }),
    });

  it('serves the stored file as an immutable woff2', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const response = await get('display-400');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('font/woff2');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
  });

  it('404s a face id it would never have written', async () => {
    // The segment is parsed against the known slots and weights rather than trusted.
    await expect(get('display-900').then((r) => r.status)).resolves.toBe(404);
    await expect(get('../../etc').then((r) => r.status)).resolves.toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s a weight the family never published', async () => {
    // A normal outcome, not a fault: the browser synthesises what is absent.
    await expect(get('display-700').then((r) => r.status)).resolves.toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a stored URL that fails the safety check', async () => {
    // The column is Json: a direct write or a restored backup could put anything there, and this
    // route fetches it server-side on an unauthenticated request.
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      customFontFiles: { display: { '400': 'http://169.254.169.254/latest/meta-data/' } },
    });

    expect((await get('display-400')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unknown client without revealing anything else', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    expect((await get('display-400')).status).toBe(404);
  });
});
