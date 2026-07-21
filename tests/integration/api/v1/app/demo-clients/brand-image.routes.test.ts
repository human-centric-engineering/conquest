/**
 * DEMO-ONLY (F7.2) integration test: demo-client brand image upload/remove routes.
 *
 * Exercises POST/DELETE /api/v1/app/demo-clients/:id/{logo,banner} with storage and sharp
 * mocked. The gate ORDER is the point: rate limit → storage configured → 404 → file present
 * → size → magic bytes → DIMENSIONS → process/upload. The dimension gate is the new one and
 * the reason this route could not just reuse the avatar endpoint.
 *
 * @see app/api/v1/app/demo-clients/_lib/brand-upload.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  appDemoClient: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const storageMock = vi.hoisted(() => ({
  isStorageEnabled: vi.fn(() => true),
  getStorageClient: vi.fn(() => ({
    name: 'local',
    upload: vi.fn(async () => ({ key: 'k', url: '/uploads/k', size: 123 })),
  })),
}));
vi.mock('@/lib/storage/client', () => storageMock);

const imageMock = vi.hoisted(() => ({
  // Return types widened explicitly: inference from the default would narrow these to the
  // happy path, and the rejection cases below need the failure shapes.
  validateImageMagicBytes: vi.fn<() => { valid: boolean; detectedType?: string; error?: string }>(
    () => ({ valid: true, detectedType: 'image/png' })
  ),
  readImageDimensions: vi.fn<() => Promise<{ width: number; height: number } | null>>(async () => ({
    width: 1600,
    height: 400,
  })),
  processImage: vi.fn(async () => ({
    buffer: Buffer.from('processed'),
    mimeType: 'image/png',
    width: 1600,
    height: 400,
  })),
  SUPPORTED_IMAGE_TYPES: ['image/png'],
}));
vi.mock('@/lib/storage/image', () => imageMock);

vi.mock('@/lib/storage/upload', () => ({ deleteByPrefix: vi.fn(async () => ({ success: true })) }));

const rateLimitMock = vi.hoisted(() => ({
  uploadLimiter: { check: vi.fn(() => ({ success: true, remaining: 9, reset: 0 })) },
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/lib/security/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as logoPOST } from '@/app/api/v1/app/demo-clients/[id]/logo/route';
import {
  POST as bannerPOST,
  DELETE as bannerDELETE,
} from '@/app/api/v1/app/demo-clients/[id]/banner/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { deleteByPrefix } from '@/lib/storage/upload';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

function uploadReq(file: File | null): NextRequest {
  const formData = new FormData();
  if (file) formData.append('file', file);
  return {
    url: 'http://localhost:3000/api/v1/app/demo-clients/dc-1/banner',
    headers: new Headers(),
    formData: async () => formData,
  } as unknown as NextRequest;
}

/** A File whose size we control without allocating the bytes. */
function fakeFile(size = 1024): File {
  const file = new File([new Uint8Array(8)], 'brand.png', { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(8) });
  return file;
}

function ctx(id = 'dc-1'): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /api/v1/app/demo-clients/:id/banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth(mockAdminUser());
    storageMock.isStorageEnabled.mockReturnValue(true);
    storageMock.getStorageClient.mockReturnValue({
      name: 'local',
      upload: vi.fn(async () => ({ key: 'k', url: '/uploads/k', size: 123 })),
    });
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/png' });
    imageMock.readImageDimensions.mockResolvedValue({ width: 1600, height: 400 });
    rateLimitMock.uploadLimiter.check.mockReturnValue({ success: true, remaining: 9, reset: 0 });
    prismaMock.appDemoClient.findUnique.mockResolvedValue({ id: 'dc-1', name: 'Acme' });
    prismaMock.appDemoClient.update.mockResolvedValue({ id: 'dc-1', name: 'Acme' });
  });

  it('rejects an unauthenticated caller', async () => {
    setAuth(null);
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 429 when the upload rate limit is exhausted', async () => {
    rateLimitMock.uploadLimiter.check.mockReturnValue({ success: false, remaining: 0, reset: 0 });
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(429);
  });

  it('returns 503 with actionable copy when storage is not configured', async () => {
    // Storage is optional in this platform; the admin can still paste a URL.
    storageMock.isStorageEnabled.mockReturnValue(false);
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await body(res))).toContain('image URL');
  });

  it('404s for an unknown demo client', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    const res = await bannerPOST(uploadReq(fakeFile()), ctx('nope'));
    expect(res.status).toBe(404);
  });

  it('400s when no file is attached', async () => {
    const res = await bannerPOST(uploadReq(null), ctx());
    expect(res.status).toBe(400);
  });

  it('400s when the file exceeds the size cap', async () => {
    const res = await bannerPOST(uploadReq(fakeFile(50 * 1024 * 1024)), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await body(res))).toContain('exceeds maximum');
  });

  it('400s when the magic bytes do not match an image, ignoring the declared MIME', async () => {
    imageMock.validateImageMagicBytes.mockReturnValue({
      valid: false,
      error: 'Invalid or unsupported image format',
    });
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(400);
  });

  it('400s a wrong-shaped banner BEFORE processing it, echoing the measurement', async () => {
    // The gate that motivated this route: a 16:9 hero must not be squashed into a 4:1 band.
    imageMock.readImageDimensions.mockResolvedValue({ width: 1920, height: 1080 });

    const res = await bannerPOST(uploadReq(fakeFile()), ctx());

    expect(res.status).toBe(400);
    const payload = JSON.stringify(await body(res));
    expect(payload).toContain('1920x1080');
    expect(imageMock.processImage).not.toHaveBeenCalled();
  });

  it('400s when dimensions cannot be read at all', async () => {
    imageMock.readImageDimensions.mockResolvedValue(null);
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(400);
    expect(imageMock.processImage).not.toHaveBeenCalled();
  });

  it("processes with fit:'inside' so the banner is never centre-cropped", async () => {
    await bannerPOST(uploadReq(fakeFile()), ctx());

    expect(imageMock.processImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fit: 'inside', format: 'jpeg', maxWidth: 1600, maxHeight: 400 })
    );
  });

  it('persists a cache-busted URL to bannerUrl and audits the change', async () => {
    const res = await bannerPOST(uploadReq(fakeFile()), ctx());

    expect(res.status).toBe(200);
    const update = prismaMock.appDemoClient.update.mock.calls[0][0] as {
      data: { bannerUrl: string };
    };
    // Fixed key + overwrite means the browser would otherwise serve the previous image.
    expect(update.data.bannerUrl).toMatch(/^\/uploads\/k\?v=\d+$/);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'app_demo_client', entityId: 'dc-1' })
    );
  });

  it('audits the URL an overwrite replaced, not a blanket null', async () => {
    // The storage key is fixed per client+kind, so re-uploading OVERWRITES. If the audit
    // entry always read `from: null` the previous banner would vanish from the trail.
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme',
      logoUrl: null,
      bannerUrl: '/uploads/k?v=111',
    });

    await bannerPOST(uploadReq(fakeFile()), ctx());

    const entry = (logAdminAction as unknown as Mock).mock.calls[0][0] as {
      changes: { bannerUrl: { from: string | null; to: string } };
    };
    expect(entry.changes.bannerUrl.from).toBe('/uploads/k?v=111');
    expect(entry.changes.bannerUrl.to).toMatch(/^\/uploads\/k\?v=\d+$/);
    expect(entry.changes.bannerUrl.to).not.toBe(entry.changes.bannerUrl.from);
  });
});

describe('POST /api/v1/app/demo-clients/:id/logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth(mockAdminUser());
    storageMock.isStorageEnabled.mockReturnValue(true);
    storageMock.getStorageClient.mockReturnValue({
      name: 'local',
      upload: vi.fn(async () => ({ key: 'k', url: '/uploads/k', size: 123 })),
    });
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/png' });
    rateLimitMock.uploadLimiter.check.mockReturnValue({ success: true, remaining: 9, reset: 0 });
    prismaMock.appDemoClient.findUnique.mockResolvedValue({ id: 'dc-1', name: 'Acme' });
    prismaMock.appDemoClient.update.mockResolvedValue({ id: 'dc-1', name: 'Acme' });
  });

  it('accepts any aspect ratio — the band letterboxes the logo', async () => {
    imageMock.readImageDimensions.mockResolvedValue({ width: 900, height: 120 });

    const res = await logoPOST(uploadReq(fakeFile()), ctx());

    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ logoUrl: expect.any(String) }) })
    );
  });

  it('stores PNG, which the invitation email and export PDFs can both render', async () => {
    imageMock.readImageDimensions.mockResolvedValue({ width: 900, height: 120 });

    await logoPOST(uploadReq(fakeFile()), ctx());

    expect(imageMock.processImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: 'png', fit: 'inside' })
    );
  });

  it('rejects a logo below the size floor', async () => {
    imageMock.readImageDimensions.mockResolvedValue({ width: 40, height: 20 });
    const res = await logoPOST(uploadReq(fakeFile()), ctx());
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/app/demo-clients/:id/banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth(mockAdminUser());
    storageMock.isStorageEnabled.mockReturnValue(true);
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme',
      logoUrl: null,
      bannerUrl: '/uploads/k?v=111',
    });
    prismaMock.appDemoClient.update.mockResolvedValue({ id: 'dc-1', name: 'Acme' });
  });

  it('clears the column and removes the stored object', async () => {
    const res = await bannerDELETE(uploadReq(null), ctx());

    expect(res.status).toBe(200);
    expect(deleteByPrefix).toHaveBeenCalledWith('demo-clients/dc-1/banner/');
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bannerUrl: null } })
    );
  });

  it('audits which URL was removed, so the trail can be walked back', async () => {
    await bannerDELETE(uploadReq(null), ctx());

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { bannerUrl: { from: '/uploads/k?v=111', to: null } },
      })
    );
  });

  it('still clears the column when storage is unavailable', async () => {
    // A column pointing at a deleted file is a broken page; a stranded object is only untidy.
    storageMock.isStorageEnabled.mockReturnValue(false);

    const res = await bannerDELETE(uploadReq(null), ctx());

    expect(res.status).toBe(200);
    expect(deleteByPrefix).not.toHaveBeenCalled();
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bannerUrl: null } })
    );
  });

  it('404s for an unknown demo client', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    const res = await bannerDELETE(uploadReq(null), ctx('nope'));
    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated caller', async () => {
    setAuth(null);
    const res = await bannerDELETE(uploadReq(null), ctx());
    expect(res.status).toBe(401);
  });
});
