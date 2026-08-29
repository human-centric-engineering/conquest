/**
 * Unit tests: the brand-import route.
 *
 * The route is a gate stack, and the ordering is the thing worth pinning: the pixel ceiling has to
 * be checked from the image HEADER before anything decodes, and the magic-byte check has to run
 * before the detected type is handed to a vision model. Each test below drives one gate.
 *
 * The other half is the failure contract: a screenshot we cannot read a brand from is a 200 with a
 * next step, not an error. Only a malformed REQUEST — no file, wrong bytes, a bomb — is a 4xx,
 * because that is the class the admin fixes by sending a different file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

const limiterMock = vi.hoisted(() => ({
  brandImportLimiter: { check: vi.fn(() => ({ success: true, reset: 0 })) },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => limiterMock);

const imageMock = vi.hoisted(() => ({
  SUPPORTED_IMAGE_TYPES: ['image/png'],
  validateImageMagicBytes: vi.fn(),
  readImageDimensions: vi.fn(),
}));
vi.mock('@/lib/storage/image', () => imageMock);

vi.mock('@/lib/validations/storage', () => ({ getMaxFileSizeBytes: () => 5 * 1024 * 1024 }));

const analyseMock = vi.hoisted(() => ({ analyseBrand: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-import', () => analyseMock);

import { POST } from '@/app/api/v1/app/demo-clients/brand-import/route';

type Handler = (request: Request, session: unknown) => Promise<Response>;
const post = POST as unknown as Handler;

const SESSION = { user: { id: 'admin-1' } };

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/brand-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function request(fields: Record<string, string | File | File[]>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry);
  }
  return new Request('http://localhost/api/v1/app/demo-clients/brand-import', {
    method: 'POST',
    body,
  });
}

function screenshot(bytes = 1024): File {
  return new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' });
}

const OK_RESULT = {
  outcome: 'ok',
  source: 'screenshot',
  fields: { canvasColor: { value: '#ffffff', confidence: 'high', source: 'read' } },
  reason: null,
  nextStep: null,
  candidates: [],
  degraded: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  limiterMock.brandImportLimiter.check.mockReturnValue({ success: true, reset: 0 });
  imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/png' });
  imageMock.readImageDimensions.mockResolvedValue({ width: 1440, height: 900 });
  analyseMock.analyseBrand.mockResolvedValue(OK_RESULT);
});

describe('POST /api/v1/app/demo-clients/brand-import', () => {
  it('analyses a valid screenshot and returns the proposals', async () => {
    const response = await post(request({ file: screenshot() }), SESSION);
    const body = (await response.json()) as { success: boolean; data: typeof OK_RESULT };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.fields.canvasColor.value).toBe('#ffffff');
  });

  it('hands the analyser the ORIGINAL bytes, whatever the upload called itself', async () => {
    // The type the magic-byte check detects no longer travels with the frame: `assignRoles`
    // re-encodes every screenshot to PNG before a model sees it, so the type attached to the vision
    // call is one we produced (asserted in assign-roles.test.ts). What still matters here is that
    // the UNTOUCHED bytes reach analysis — the palette is measured from the original, not from the
    // downsample. The magic-byte check keeps its job as the gate that refuses a non-image, covered
    // by 'rejects bytes that are not an image' below.
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/webp' });

    await post(request({ file: screenshot(64) }), SESSION);

    const passed = analyseMock.analyseBrand.mock.calls[0][0].screenshots;
    expect(passed).toHaveLength(1);
    expect(Buffer.isBuffer(passed[0])).toBe(true);
    expect(passed[0]).toHaveLength(64);
  });

  it('threads an optional demoClientId through for cost attribution', async () => {
    await post(request({ file: screenshot(), demoClientId: 'dc-1' }), SESSION);

    expect(analyseMock.analyseBrand).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'dc-1' })
    );
  });

  it('works with no demoClientId, because the create form has no client yet', async () => {
    await post(request({ file: screenshot() }), SESSION);

    expect(analyseMock.analyseBrand).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: undefined })
    );
  });

  it('returns an empty analysis as a 200 with a next step, not an error', async () => {
    analyseMock.analyseBrand.mockResolvedValue({
      ...OK_RESULT,
      outcome: 'empty',
      fields: {},
      reason: 'We could not find anything that looked like a brand.',
      nextStep: 'manual',
    });

    const response = await post(request({ file: screenshot() }), SESSION);
    const body = (await response.json()) as { success: boolean; data: { outcome: string } };

    expect(response.status).toBe(200);
    expect(body.data.outcome).toBe('empty');
  });

  it('rejects a multipart request carrying neither an address nor a file', async () => {
    await expect(post(request({}), SESSION)).rejects.toThrow(
      'Add a website address or a screenshot'
    );
  });

  it('rejects bytes that are not an image, before anything reads them as one', async () => {
    imageMock.validateImageMagicBytes.mockReturnValue({
      valid: false,
      error: 'Unsupported image format',
    });

    await expect(post(request({ file: screenshot() }), SESSION)).rejects.toThrow(
      'Unsupported image format'
    );
    expect(imageMock.readImageDimensions).not.toHaveBeenCalled();
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the magic-byte check gives no reason', async () => {
    // A detected type of undefined also fails this gate (the type is forwarded to the vision
    // call and must never be missing) — and neither case guarantees an `error` string.
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: undefined });

    await expect(post(request({ file: screenshot() }), SESSION)).rejects.toThrow(
      'not an image we can read'
    );
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('rejects a file over the byte cap before reading it into memory as a buffer', async () => {
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'shot.png', {
      type: 'image/png',
    });

    await expect(post(request({ file: oversized }), SESSION)).rejects.toThrow('maximum of 5 MB');
    expect(imageMock.validateImageMagicBytes).not.toHaveBeenCalled();
  });

  it('rejects a decompression bomb on its header dimensions, before any decode', async () => {
    // A solid-colour 16000x16000 PNG is ~200KB on disk and ~1GB decoded: it clears the byte cap
    // and every other gate, so the pixel ceiling is the only thing standing in front of it.
    imageMock.readImageDimensions.mockResolvedValue({ width: 16000, height: 16000 });

    await expect(post(request({ file: screenshot() }), SESSION)).rejects.toThrow('too large');
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('rejects a screenshot too small to hold a page', async () => {
    imageMock.readImageDimensions.mockResolvedValue({ width: 200, height: 150 });

    await expect(post(request({ file: screenshot() }), SESSION)).rejects.toThrow('at least 320');
  });

  it('rejects an image whose dimensions cannot be read', async () => {
    imageMock.readImageDimensions.mockResolvedValue(null);

    await expect(post(request({ file: screenshot() }), SESSION)).rejects.toThrow(
      'Could not read the image dimensions'
    );
  });

  it('analyses an address and its screenshots in one call', async () => {
    await post(request({ url: 'acme.example', file: [screenshot(), screenshot()] }), SESSION);

    // The two are complementary evidence about one brand, so they are one analysis: only the site
    // names a logo, only a picture measures what the page is painted in.
    expect(analyseMock.analyseBrand).toHaveBeenCalledTimes(1);
    expect(analyseMock.analyseBrand).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'acme.example',
        screenshots: [expect.any(Buffer), expect.any(Buffer)],
      })
    );
  });

  it('ignores a blank address field rather than harvesting an empty string', async () => {
    await post(request({ url: '   ', file: screenshot() }), SESSION);

    expect(analyseMock.analyseBrand).toHaveBeenCalledWith(
      expect.objectContaining({ url: undefined })
    );
  });

  it('states the screenshot cap instead of silently dropping the extras', async () => {
    // Dropping them would look exactly like an import that ignored what the admin sent.
    await expect(
      post(request({ file: [screenshot(), screenshot(), screenshot(), screenshot()] }), SESSION)
    ).rejects.toThrow('Up to 3 screenshots');
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('puts every file through the gates, not just the first', async () => {
    imageMock.validateImageMagicBytes
      .mockReturnValueOnce({ valid: true, detectedType: 'image/png' })
      .mockReturnValueOnce({ valid: false, error: 'Unsupported image format' });

    await expect(post(request({ file: [screenshot(), screenshot()] }), SESSION)).rejects.toThrow(
      'Unsupported image format'
    );
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('applies the per-admin sub-cap before doing any work', async () => {
    limiterMock.brandImportLimiter.check.mockReturnValue({ success: false, reset: 1 });

    const response = await post(request({ file: screenshot() }), SESSION);

    expect(response.status).toBe(429);
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/app/demo-clients/brand-import (url)', () => {
  it('routes a JSON body to the site harvest', async () => {
    analyseMock.analyseBrand.mockResolvedValue({ ...OK_RESULT, source: 'url' });

    const response = await post(jsonRequest({ url: 'acme.example' }), SESSION);
    const body = (await response.json()) as { data: { source: string } };

    expect(response.status).toBe(200);
    expect(body.data.source).toBe('url');
    expect(analyseMock.analyseBrand).toHaveBeenCalledWith({
      url: 'acme.example',
      demoClientId: undefined,
    });
    // The two shapes are distinguished by content type, so a JSON body must never be read as
    // multipart — `request.formData()` on a JSON body would throw before any of this ran.
    expect(analyseMock.analyseBrand).toHaveBeenCalledWith(
      expect.not.objectContaining({ screenshots: expect.anything() })
    );
  });

  it('passes the client id through when the edit form supplies one', async () => {
    await post(jsonRequest({ url: 'acme.example', demoClientId: 'dc-1' }), SESSION);

    expect(analyseMock.analyseBrand).toHaveBeenCalledWith({
      url: 'acme.example',
      demoClientId: 'dc-1',
    });
  });

  it('returns a blocked harvest as a 200 carrying its next step', async () => {
    // A bot wall is the single most common outcome of this feature and it is not an error: the
    // admin needs the reason and the screenshot tab, not a 502.
    analyseMock.analyseBrand.mockResolvedValue({
      ...OK_RESULT,
      source: 'url',
      outcome: 'blocked',
      fields: {},
      reason: 'That site refused our request (403).',
      nextStep: 'screenshot',
    });

    const response = await post(jsonRequest({ url: 'acme.example' }), SESSION);
    const body = (await response.json()) as { data: { outcome: string; nextStep: string } };

    expect(response.status).toBe(200);
    expect(body.data.outcome).toBe('blocked');
    expect(body.data.nextStep).toBe('screenshot');
  });

  it('rejects a JSON body with no address', async () => {
    await expect(post(jsonRequest({}), SESSION)).rejects.toThrow('website address is required');
  });

  it('treats an unparsable JSON body as a missing address, not a crash', async () => {
    // request.json() rejects on malformed JSON; the `.catch(() => null)` ahead of safeParse must
    // turn that into the same 400 a missing field gets, never an unhandled rejection reaching
    // withAdminAuth as a 500.
    const malformed = new Request('http://localhost/api/v1/app/demo-clients/brand-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    await expect(post(malformed, SESSION)).rejects.toThrow('website address is required');
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });

  it('applies the sub-cap to the url branch too', async () => {
    limiterMock.brandImportLimiter.check.mockReturnValue({ success: false, reset: 1 });

    const response = await post(jsonRequest({ url: 'acme.example' }), SESSION);

    expect(response.status).toBe(429);
    expect(analyseMock.analyseBrand).not.toHaveBeenCalled();
  });
});
