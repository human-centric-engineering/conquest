/**
 * Unit tests for the intro-background authoring routes (F12.2).
 *
 *   - app/api/v1/app/questionnaires/intro-background/author/route.ts (POST — generate / refine)
 *   - app/api/v1/app/questionnaires/intro-background/parse/route.ts  (POST — multipart parse)
 *
 * Collaborators are mocked at the module boundary; the real input schema + upload guard run. Tests
 * assert what the routes DO — status codes, envelope shapes, dispatch args — not mock echoes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  composeLimiter: { check: vi.fn(() => ({ success: true })) },
  ingestLimiter: { check: vi.fn(() => ({ success: true })) },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/compose-pipeline', () => ({
  loadComposerAgent: vi.fn(),
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));
vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/intro-background/_lib/generation-context', () => ({
  loadIntroGenerationContext: vi.fn(),
}));

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;
const { POST: authorPost } =
  (await import('@/app/api/v1/app/questionnaires/intro-background/author/route')) as {
    POST: AnyRouteHandler;
  };
const { POST: parsePost } =
  (await import('@/app/api/v1/app/questionnaires/intro-background/parse/route')) as {
    POST: AnyRouteHandler;
  };

import { composeLimiter, ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadComposerAgent } from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { loadIntroGenerationContext } from '@/app/api/v1/app/questionnaires/intro-background/_lib/generation-context';

type Mock = ReturnType<typeof vi.fn>;
const ADMIN = { user: { id: 'admin-1' } };
const AGENT = { id: 'agent-1', provider: 'anthropic', model: 'claude', fallbackProviders: [] };

function jsonReq(body: unknown) {
  return new NextRequest('http://localhost/api/v1/app/questionnaires/intro-background/author', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function uploadReq(file: File | null) {
  const form = new FormData();
  if (file) form.append('file', file);
  return new NextRequest('http://localhost/api/v1/app/questionnaires/intro-background/parse', {
    method: 'POST',
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (composeLimiter.check as Mock).mockReturnValue({ success: true });
  (ingestLimiter.check as Mock).mockReturnValue({ success: true });
  (loadComposerAgent as Mock).mockResolvedValue({ ok: true, value: AGENT });
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: { background: 'Generated intro.' },
  });
  (parseDocument as Mock).mockResolvedValue({ fullText: 'Extracted document text.' });
  (loadIntroGenerationContext as Mock).mockResolvedValue(null);
});

describe('author route', () => {
  it('returns 429 when the per-admin sub-cap is exceeded', async () => {
    (composeLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await authorPost(jsonReq({ mode: 'generate', brief: 'x' }), ADMIN);
    expect(res.status).toBe(429);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('400s an invalid body (generate without a brief)', async () => {
    const res = await authorPost(jsonReq({ mode: 'generate' }), ADMIN);
    expect(res.status).toBe(400);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('surfaces the composer-not-configured response', async () => {
    (loadComposerAgent as Mock).mockResolvedValue({
      ok: false,
      response: new Response('no agent', { status: 503 }),
    });
    const res = await authorPost(jsonReq({ mode: 'generate', brief: 'x' }), ADMIN);
    expect(res.status).toBe(503);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('maps a dispatch failure to an error status', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'down' },
    });
    const res = await authorPost(jsonReq({ mode: 'generate', brief: 'x' }), ADMIN);
    expect(res.status).toBe(503);
  });

  it('maps an unrecognised dispatch error code to 502 with AUTHORING_FAILED', async () => {
    // 'authoring_failed' is not in the dispatchErrorStatus switch → hits the default → 502
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'authoring_failed', message: 'unexpected failure' },
    });
    const res = await authorPost(jsonReq({ mode: 'generate', brief: 'x' }), ADMIN);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AUTHORING_FAILED');
  });

  it('dispatches the capability and returns the background on success', async () => {
    const res = await authorPost(jsonReq({ mode: 'generate', brief: 'Acme survey' }), ADMIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { background: string } };
    expect(body.success).toBe(true);
    expect(body.data.background).toBe('Generated intro.');
    const [slug, args, ctx] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(slug).toBe('app_author_intro_background');
    expect(args).toMatchObject({ mode: 'generate', brief: 'Acme survey' });
    expect(ctx.agentId).toBe('agent-1');
    expect(ctx.entityContext.composerAgent.model).toBe('claude');
  });

  it('does not load grounding context when no version pair is sent', async () => {
    await authorPost(jsonReq({ mode: 'generate', brief: 'Acme survey' }), ADMIN);
    expect(loadIntroGenerationContext).not.toHaveBeenCalled();
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('questionnaireContext');
  });

  it('grounds the generate call in the version goal + questions when the pair is sent', async () => {
    (loadIntroGenerationContext as Mock).mockResolvedValue('Goal: x\n\nQuestions:\n- a');
    await authorPost(
      jsonReq({ mode: 'generate', brief: 'Acme survey', questionnaireId: 'q-1', versionId: 'v-1' }),
      ADMIN
    );
    expect(loadIntroGenerationContext).toHaveBeenCalledWith('q-1', 'v-1');
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    // The ids are stripped; only the formatted context string reaches the capability.
    expect(args).toMatchObject({
      mode: 'generate',
      brief: 'Acme survey',
      questionnaireContext: 'Goal: x\n\nQuestions:\n- a',
    });
    expect(args).not.toHaveProperty('questionnaireId');
    expect(args).not.toHaveProperty('versionId');
  });

  it('omits questionnaireContext when the version pair resolves to no context', async () => {
    (loadIntroGenerationContext as Mock).mockResolvedValue(null);
    await authorPost(
      jsonReq({ mode: 'generate', brief: 'Acme survey', questionnaireId: 'q-1', versionId: 'v-1' }),
      ADMIN
    );
    expect(loadIntroGenerationContext).toHaveBeenCalledWith('q-1', 'v-1');
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('questionnaireContext');
  });
});

describe('parse route', () => {
  it('429s when the per-admin parse sub-cap is exceeded', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await parsePost(uploadReq(new File(['hi'], 'about.txt')), ADMIN);
    expect(res.status).toBe(429);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('400s when no file is provided', async () => {
    const res = await parsePost(uploadReq(null), ADMIN);
    expect(res.status).toBe(400);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('returns the extracted text for a valid document', async () => {
    const res = await parsePost(uploadReq(new File(['hi'], 'about.txt')), ADMIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { text: string; truncated: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.data.text).toBe('Extracted document text.');
    expect(body.data.truncated).toBe(false);
  });

  it('422s when the document yields no text', async () => {
    (parseDocument as Mock).mockResolvedValue({ fullText: '   ' });
    const res = await parsePost(uploadReq(new File(['x'], 'about.txt')), ADMIN);
    expect(res.status).toBe(422);
  });

  it('422s when the parser throws', async () => {
    (parseDocument as Mock).mockRejectedValue(new Error('corrupt'));
    const res = await parsePost(uploadReq(new File(['x'], 'about.pdf')), ADMIN);
    expect(res.status).toBe(422);
  });
});
