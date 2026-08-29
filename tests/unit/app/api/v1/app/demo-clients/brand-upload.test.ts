/**
 * Unit tests: `brandImageHandlers()`, the shared upload/remove pipeline behind the logo,
 * banner, mark, and dark-logo demo-client routes.
 *
 * tests/integration/api/v1/app/demo-clients/brand-image.routes.test.ts drives this module
 * through the exported routes end-to-end, but only ever sends a MULTIPART upload. This file
 * targets the module directly to reach what that suite does not:
 *
 *  - the JSON `{ sourceUrl }` branch (`bytesFromSourceUrl`) the brand importer uses to
 *    re-host a logo it found on the open web — the SSRF-guarded fetch, the SVG→PNG
 *    conversion, and the pass-through for a fetch that is already a raster
 *  - a handful of upload-branch edges the integration suite's fixed fixtures don't hit
 *    (the magic-byte fallback message, storage vanishing between the two gates that check
 *    it, the dimension-rejection error's `details` payload)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { APIError } from '@/lib/api/errors';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/validations/storage', () => ({ getMaxFileSizeBytes: () => 5 * 1024 * 1024 }));
vi.mock('@/lib/storage/upload', () => ({ deleteByPrefix: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  uploadLimiter: { check: vi.fn(() => ({ success: true, remaining: 9, reset: 0 })) },
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/lib/security/rate-limit', () => rateLimitMock);

const prismaMock = vi.hoisted(() => ({
  appDemoClient: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const storageMock = vi.hoisted(() => ({
  isStorageEnabled: vi.fn(() => true),
  getStorageClient: vi.fn(),
}));
vi.mock('@/lib/storage/client', () => storageMock);

const imageMock = vi.hoisted(() => ({
  validateImageMagicBytes: vi.fn<() => { valid: boolean; detectedType?: string; error?: string }>(
    () => ({ valid: true, detectedType: 'image/png' })
  ),
  readImageDimensions: vi.fn<() => Promise<{ width: number; height: number } | null>>(async () => ({
    width: 900,
    height: 200,
  })),
  processImage: vi.fn(async () => ({
    buffer: Buffer.from('processed-bytes'),
    mimeType: 'image/png',
    width: 900,
    height: 200,
  })),
  SUPPORTED_IMAGE_TYPES: ['image/png'],
}));
vi.mock('@/lib/storage/image', () => imageMock);

const brandImportLibMock = vi.hoisted(() => {
  // A real `class`, not an arrow function: `new HarvestBudget(...)` requires a constructible
  // implementation, and wrapping it in `vi.fn(...)` keeps it spyable for call-argument assertions.
  class FakeHarvestBudget {
    limits: unknown;
    constructor(limits: unknown) {
      this.limits = limits;
    }
  }
  return {
    fetchResource: vi.fn(),
    HarvestBudget: vi.fn(FakeHarvestBudget),
  };
});
vi.mock('@/lib/app/questionnaire/brand-import', () => brandImportLibMock);

const rasteriseMock = vi.hoisted(() => ({
  rasteriseSvg: vi.fn<() => Promise<Buffer | null>>(async () => null),
}));
vi.mock('@/app/api/v1/app/demo-clients/_lib/rasterise-svg', () => rasteriseMock);

import { brandImageHandlers } from '@/app/api/v1/app/demo-clients/_lib/brand-upload';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { deleteByPrefix } from '@/lib/storage/upload';

type AdminHandler = (
  request: Request,
  session: unknown,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response>;

// `logo`: no aspect-ratio rule, PNG output — the simplest spec, which keeps every test here
// about the SHARED pipeline rather than one kind's shape rule (the integration suite already
// covers the banner/mark ratio gates per kind).
const { POST: postRaw, DELETE: deleteRaw } = brandImageHandlers('logo');
const post = postRaw as unknown as AdminHandler;
const del = deleteRaw as unknown as AdminHandler;

const SESSION = { user: { id: 'admin-1' } };
const ctx = (id = 'dc-1'): { params: Promise<{ id: string }> } => ({
  params: Promise.resolve({ id }),
});

function logoFile(bytes = 1024): File {
  return new File([new Uint8Array(bytes)], 'logo.png', { type: 'image/png' });
}

function uploadReq(fields: Record<string, string | File> = { file: logoFile() }): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/logo', {
    method: 'POST',
    body,
  });
}

function emptyMultipartReq(): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/logo', {
    method: 'POST',
    body: new FormData(),
  });
}

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/logo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function malformedJsonReq(): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/logo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
}

function deleteReq(): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/dc-1/logo', { method: 'DELETE' });
}

const CLIENT_ROW = {
  id: 'dc-1',
  name: 'Acme',
  logoUrl: null as string | null,
  bannerUrl: null as string | null,
  logoMarkUrl: null as string | null,
  logoDarkUrl: null as string | null,
};

const uploadMock = vi.fn(
  async (
    _buffer: Buffer,
    opts: { key: string; contentType: string; metadata: Record<string, unknown> }
  ) => ({
    key: opts.key,
    url: `https://blob.example/${opts.key}`,
    size: 100,
  })
);

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.uploadLimiter.check.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  storageMock.isStorageEnabled.mockReturnValue(true);
  storageMock.getStorageClient.mockReturnValue({ upload: uploadMock });
  imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/png' });
  imageMock.readImageDimensions.mockResolvedValue({ width: 900, height: 200 });
  imageMock.processImage.mockResolvedValue({
    buffer: Buffer.from('processed-bytes'),
    mimeType: 'image/png',
    width: 900,
    height: 200,
  });
  prismaMock.appDemoClient.findUnique.mockResolvedValue({ ...CLIENT_ROW });
  prismaMock.appDemoClient.update.mockResolvedValue({ id: 'dc-1' });
  brandImportLibMock.fetchResource.mockResolvedValue({
    ok: true,
    buffer: Buffer.from('fetched-bytes'),
    contentType: 'image/png',
    finalUrl: 'https://acme.example/logo.png',
  });
  rasteriseMock.rasteriseSvg.mockResolvedValue(null);
});

describe('POST — shared gates', () => {
  it('short-circuits on the upload rate limit before touching the database', async () => {
    rateLimitMock.uploadLimiter.check.mockReturnValue({ success: false, remaining: 0, reset: 5 });

    const res = await post(uploadReq(), SESSION, ctx());

    expect(res.status).toBe(429);
    expect(prismaMock.appDemoClient.findUnique).not.toHaveBeenCalled();
  });

  it('refuses when storage is not configured, before reading the client', async () => {
    storageMock.isStorageEnabled.mockReturnValue(false);

    await expect(post(uploadReq(), SESSION, ctx())).rejects.toThrow('use an image URL instead');
    expect(prismaMock.appDemoClient.findUnique).not.toHaveBeenCalled();
  });

  it('404s an unknown demo client', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);

    await expect(post(uploadReq(), SESSION, ctx('nope'))).rejects.toThrow('Demo client not found');
  });
});

describe('POST — multipart branch (bytesFromUpload)', () => {
  it('rejects a multipart request with no file', async () => {
    await expect(post(emptyMultipartReq(), SESSION, ctx())).rejects.toThrow('No file provided');
  });

  it('rejects a file over the size cap before reading it into memory', async () => {
    // A real over-cap buffer, not a stubbed `.size` — this request round-trips through a real
    // multipart encode/decode, which would silently discard a property override that doesn't
    // match the actual bytes.
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'logo.png', { type: 'image/png' });

    await expect(post(uploadReq({ file: big }), SESSION, ctx())).rejects.toThrow(
      'exceeds maximum of 5 MB'
    );
    expect(imageMock.validateImageMagicBytes).not.toHaveBeenCalled();
  });
});

describe('POST — URL branch (bytesFromSourceUrl)', () => {
  it('rejects a JSON body with no sourceUrl', async () => {
    await expect(post(jsonReq({}), SESSION, ctx())).rejects.toThrow('No image address provided');
    expect(brandImportLibMock.fetchResource).not.toHaveBeenCalled();
  });

  it('rejects a blank sourceUrl', async () => {
    await expect(post(jsonReq({ sourceUrl: '   ' }), SESSION, ctx())).rejects.toThrow(
      'No image address provided'
    );
    expect(brandImportLibMock.fetchResource).not.toHaveBeenCalled();
  });

  it('treats an unparsable JSON body as a missing address, not a crash', async () => {
    // request.json() rejects on malformed JSON; the `.catch(() => null)` must turn that into
    // the same 400 a missing field gets, never an unhandled rejection.
    await expect(post(malformedJsonReq(), SESSION, ctx())).rejects.toThrow(
      'No image address provided'
    );
    expect(brandImportLibMock.fetchResource).not.toHaveBeenCalled();
  });

  it('surfaces the SSRF guard refusal reason as the error message', async () => {
    brandImportLibMock.fetchResource.mockResolvedValue({
      ok: false,
      reason: 'That address resolves to a private network — we cannot fetch it.',
    });

    await expect(
      post(jsonReq({ sourceUrl: 'http://169.254.169.254/' }), SESSION, ctx())
    ).rejects.toThrow('private network');
    expect(imageMock.validateImageMagicBytes).not.toHaveBeenCalled();
  });

  it('trims the address and asks the fetch for an image, with a bounded budget', async () => {
    await post(jsonReq({ sourceUrl: '  https://acme.example/logo.png  ' }), SESSION, ctx());

    expect(brandImportLibMock.fetchResource).toHaveBeenCalledWith(
      'https://acme.example/logo.png',
      expect.anything(),
      { accept: 'image/*' }
    );
    expect(brandImportLibMock.HarvestBudget).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequests: 6, timeoutMs: 15_000 })
    );
  });

  it('rasterises a fetched SVG and sends the PNG bytes downstream, never the raw vector', async () => {
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const rasterisedPng = Buffer.from('rasterised-png-bytes');
    brandImportLibMock.fetchResource.mockResolvedValue({
      ok: true,
      buffer: svgBytes,
      contentType: 'image/svg+xml',
      finalUrl: 'https://acme.example/logo.svg',
    });
    rasteriseMock.rasteriseSvg.mockResolvedValue(rasterisedPng);

    await post(jsonReq({ sourceUrl: 'https://acme.example/logo.svg' }), SESSION, ctx());

    expect(rasteriseMock.rasteriseSvg).toHaveBeenCalledWith(
      svgBytes,
      'image/svg+xml',
      'https://acme.example/logo.svg'
    );
    // The magic-byte check is the first thing the shared pipeline does with the bytes — it must
    // see the raster the rasteriser produced, never the vector source bytes.
    expect(imageMock.validateImageMagicBytes).toHaveBeenCalledWith(rasterisedPng);
    expect(imageMock.validateImageMagicBytes).not.toHaveBeenCalledWith(svgBytes);
  });

  it('passes an already-raster fetch straight through unchanged', async () => {
    const pngBytes = Buffer.from('already-a-png');
    brandImportLibMock.fetchResource.mockResolvedValue({
      ok: true,
      buffer: pngBytes,
      contentType: 'image/png',
      finalUrl: 'https://acme.example/logo.png',
    });
    rasteriseMock.rasteriseSvg.mockResolvedValue(null);

    await post(jsonReq({ sourceUrl: 'https://acme.example/logo.png' }), SESSION, ctx());

    expect(rasteriseMock.rasteriseSvg).toHaveBeenCalledWith(
      pngBytes,
      'image/png',
      'https://acme.example/logo.png'
    );
    expect(imageMock.validateImageMagicBytes).toHaveBeenCalledWith(pngBytes);
  });
});

describe('POST — validation gates shared by both branches', () => {
  it('rejects bytes that are not a recognised image, before dimensions are read', async () => {
    imageMock.validateImageMagicBytes.mockReturnValue({
      valid: false,
      error: 'Unsupported image format',
    });

    await expect(post(uploadReq(), SESSION, ctx())).rejects.toThrow('Unsupported image format');
    expect(imageMock.readImageDimensions).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the magic-byte check gives no reason', async () => {
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: false });

    await expect(post(uploadReq(), SESSION, ctx())).rejects.toThrow('Invalid image format');
    expect(imageMock.readImageDimensions).not.toHaveBeenCalled();
  });

  it('rejects an image whose dimensions cannot be read', async () => {
    imageMock.readImageDimensions.mockResolvedValue(null);

    await expect(post(uploadReq(), SESSION, ctx())).rejects.toThrow(
      'Could not read image dimensions'
    );
    expect(imageMock.processImage).not.toHaveBeenCalled();
  });

  it('rejects an undersized logo and reports the measured size in the error details', async () => {
    imageMock.readImageDimensions.mockResolvedValue({ width: 40, height: 20 });

    let caught: unknown;
    try {
      await post(uploadReq(), SESSION, ctx());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIError);
    const error = caught as APIError;
    expect(error.message).toContain('must be at least 80x40px');
    expect(error.details).toMatchObject({
      width: 40,
      height: 20,
      expected: { minWidth: 80, minHeight: 40, aspectRatio: null },
    });
    expect(imageMock.processImage).not.toHaveBeenCalled();
  });

  it('refuses when the storage client is unavailable even though storage reports enabled', async () => {
    storageMock.getStorageClient.mockReturnValue(null);

    await expect(post(uploadReq(), SESSION, ctx())).rejects.toThrow(
      'File uploads are not configured'
    );
    expect(prismaMock.appDemoClient.update).not.toHaveBeenCalled();
  });
});

describe('POST — success path', () => {
  it('processes with the spec-derived options, uploads under the fixed key, and persists a cache-busted URL', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      ...CLIENT_ROW,
      logoUrl: 'https://old.example/logo.png?v=1',
    });
    imageMock.processImage.mockResolvedValue({
      buffer: Buffer.from('final-bytes'),
      mimeType: 'image/png',
      width: 300,
      height: 100,
    });

    const res = await post(uploadReq(), SESSION, ctx());
    const parsed = (await res.json()) as {
      success: boolean;
      data: { url: string; kind: string; width: number; height: number; size: number };
    };

    expect(res.status).toBe(200);
    // Spec-derived processing options, not just a pass-through of whatever was given.
    expect(imageMock.processImage).toHaveBeenCalledWith(expect.any(Buffer), {
      maxWidth: 1200,
      maxHeight: 1200,
      format: 'png',
      fit: 'inside',
    });
    // The upload key is built from the id, kind, and the spec's own format extension.
    expect(uploadMock).toHaveBeenCalledWith(
      Buffer.from('final-bytes'),
      expect.objectContaining({
        key: 'demo-clients/dc-1/logo/logo.png',
        contentType: 'image/png',
        metadata: expect.objectContaining({ demoClientId: 'dc-1', kind: 'logo' }),
        public: true,
      })
    );

    expect(parsed.data.width).toBe(300);
    expect(parsed.data.height).toBe(100);
    expect(parsed.data.size).toBe(Buffer.from('final-bytes').length);
    // Cache-bust query so a browser holding the old URL fetches the new file.
    expect(parsed.data.url).toMatch(
      /^https:\/\/blob\.example\/demo-clients\/dc-1\/logo\/logo\.png\?v=\d+$/
    );

    const update = prismaMock.appDemoClient.update.mock.calls[0][0] as {
      data: { logoUrl: string };
    };
    expect(update.data.logoUrl).toBe(parsed.data.url);

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'app_demo_client',
        entityId: 'dc-1',
        changes: { logoUrl: { from: 'https://old.example/logo.png?v=1', to: parsed.data.url } },
      })
    );
  });
});

describe('DELETE', () => {
  it('404s an unknown demo client', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);

    await expect(del(deleteReq(), SESSION, ctx('nope'))).rejects.toThrow('Demo client not found');
  });

  it('clears the column and removes the stored object when storage is enabled', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      ...CLIENT_ROW,
      logoUrl: 'https://blob.example/logo.png?v=1',
    });

    const res = await del(deleteReq(), SESSION, ctx());

    expect(res.status).toBe(200);
    expect(deleteByPrefix).toHaveBeenCalledWith('demo-clients/dc-1/logo/');
    const update = prismaMock.appDemoClient.update.mock.calls[0][0] as { data: { logoUrl: null } };
    expect(update.data.logoUrl).toBeNull();
  });

  it('still clears the column when storage is unavailable, so a broken page never lingers', async () => {
    storageMock.isStorageEnabled.mockReturnValue(false);

    const res = await del(deleteReq(), SESSION, ctx());

    expect(res.status).toBe(200);
    expect(deleteByPrefix).not.toHaveBeenCalled();
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { logoUrl: null } })
    );
  });

  it('audits which URL was removed and responds with the kind cleared', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      ...CLIENT_ROW,
      logoUrl: 'https://blob.example/logo.png?v=1',
    });

    const res = await del(deleteReq(), SESSION, ctx());
    const body = (await res.json()) as { data: { kind: string } };

    expect(body.data.kind).toBe('logo');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { logoUrl: { from: 'https://blob.example/logo.png?v=1', to: null } },
      })
    );
  });
});
