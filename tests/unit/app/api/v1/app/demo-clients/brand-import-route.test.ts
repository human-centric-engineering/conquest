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

const analyseMock = vi.hoisted(() => ({ analyseScreenshot: vi.fn(), analyseUrl: vi.fn() }));
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

function request(fields: Record<string, string | File>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
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
  analyseMock.analyseScreenshot.mockResolvedValue(OK_RESULT);
  analyseMock.analyseUrl.mockResolvedValue({ ...OK_RESULT, source: 'url' });
});

describe('POST /api/v1/app/demo-clients/brand-import', () => {
  it('analyses a valid screenshot and returns the proposals', async () => {
    const response = await post(request({ file: screenshot() }), SESSION);
    const body = (await response.json()) as { success: boolean; data: typeof OK_RESULT };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.fields.canvasColor.value).toBe('#ffffff');
  });

  it('passes the DETECTED media type to the analyser, never the browser-declared one', async () => {
    // The detected type is what gets attached to the vision call; forwarding the client's claim
    // would send the provider a lie about the payload.
    imageMock.validateImageMagicBytes.mockReturnValue({ valid: true, detectedType: 'image/webp' });

    await post(request({ file: screenshot() }), SESSION);

    expect(analyseMock.analyseScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 'image/webp' })
    );
  });

  it('threads an optional demoClientId through for cost attribution', async () => {
    await post(request({ file: screenshot(), demoClientId: 'dc-1' }), SESSION);

    expect(analyseMock.analyseScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'dc-1' })
    );
  });

  it('works with no demoClientId, because the create form has no client yet', async () => {
    await post(request({ file: screenshot() }), SESSION);

    expect(analyseMock.analyseScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: undefined })
    );
  });

  it('returns an empty analysis as a 200 with a next step, not an error', async () => {
    analyseMock.analyseScreenshot.mockResolvedValue({
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

  it('rejects a request with no file', async () => {
    await expect(post(request({}), SESSION)).rejects.toThrow('No screenshot provided');
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
    expect(analyseMock.analyseScreenshot).not.toHaveBeenCalled();
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
    expect(analyseMock.analyseScreenshot).not.toHaveBeenCalled();
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

  it('applies the per-admin sub-cap before doing any work', async () => {
    limiterMock.brandImportLimiter.check.mockReturnValue({ success: false, reset: 1 });

    const response = await post(request({ file: screenshot() }), SESSION);

    expect(response.status).toBe(429);
    expect(analyseMock.analyseScreenshot).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/app/demo-clients/brand-import (url)', () => {
  it('routes a JSON body to the site harvest', async () => {
    const response = await post(jsonRequest({ url: 'acme.example' }), SESSION);
    const body = (await response.json()) as { data: { source: string } };

    expect(response.status).toBe(200);
    expect(body.data.source).toBe('url');
    expect(analyseMock.analyseUrl).toHaveBeenCalledWith({
      url: 'acme.example',
      demoClientId: undefined,
    });
    // The two shapes are distinguished by content type, so a JSON body must never be read as
    // multipart — `request.formData()` on a JSON body would throw before any of this ran.
    expect(analyseMock.analyseScreenshot).not.toHaveBeenCalled();
  });

  it('passes the client id through when the edit form supplies one', async () => {
    await post(jsonRequest({ url: 'acme.example', demoClientId: 'dc-1' }), SESSION);

    expect(analyseMock.analyseUrl).toHaveBeenCalledWith({
      url: 'acme.example',
      demoClientId: 'dc-1',
    });
  });

  it('returns a blocked harvest as a 200 carrying its next step', async () => {
    // A bot wall is the single most common outcome of this feature and it is not an error: the
    // admin needs the reason and the screenshot tab, not a 502.
    analyseMock.analyseUrl.mockResolvedValue({
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

  it('applies the sub-cap to the url branch too', async () => {
    limiterMock.brandImportLimiter.check.mockReturnValue({ success: false, reset: 1 });

    const response = await post(jsonRequest({ url: 'acme.example' }), SESSION);

    expect(response.status).toBe(429);
    expect(analyseMock.analyseUrl).not.toHaveBeenCalled();
  });
});
