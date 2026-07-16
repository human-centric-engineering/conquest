/**
 * Unit tests for the round Additional Context AI routes (phase 3).
 *
 *   - app/api/v1/app/rounds/[id]/context/suggest/route.ts (POST — AI proposals)
 *   - app/api/v1/app/rounds/[id]/context/parse/route.ts   (POST — multipart text extraction)
 *
 * Collaborators are mocked at the module boundary; the routes' own validation runs. Tests assert
 * status codes, envelope shapes, and dispatch wiring — not mock echoes.
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
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireRound: { findUnique: vi.fn() } },
}));
vi.mock('@/app/api/v1/app/rounds/_lib/context', () => ({
  assertRoundBundlesVersion: vi.fn(),
  loadVersionForSuggest: vi.fn(),
}));

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;
const { POST: suggestPost } =
  (await import('@/app/api/v1/app/rounds/[id]/context/suggest/route')) as { POST: AnyRouteHandler };
const { POST: parsePost } = (await import('@/app/api/v1/app/rounds/[id]/context/parse/route')) as {
  POST: AnyRouteHandler;
};

import { loadComposerAgent } from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { composeLimiter, ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { prisma } from '@/lib/db/client';
import {
  assertRoundBundlesVersion,
  loadVersionForSuggest,
} from '@/app/api/v1/app/rounds/_lib/context';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
// Full better-auth session shape (withAdminAuth is identity-mocked here, so we pass it directly).
const ADMIN = mockAdminUser();
const AGENT = { id: 'agent-1', provider: 'anthropic', model: 'claude', fallbackProviders: [] };
const ctx = { params: Promise.resolve({ id: 'r-1' }) };

function jsonReq(body: unknown) {
  return new NextRequest('http://localhost/api/v1/app/rounds/r-1/context/suggest', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
function uploadReq(file: File | null) {
  const form = new FormData();
  if (file) form.append('file', file);
  return new NextRequest('http://localhost/api/v1/app/rounds/r-1/context/parse', {
    method: 'POST',
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but NOT implementations set via mockReturnValue, so restore the
  // limiters' default "allowed" each test (a prior rate-limit test would otherwise leak success:false).
  (composeLimiter.check as Mock).mockReturnValue({ success: true });
  (ingestLimiter.check as Mock).mockReturnValue({ success: true });
  (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({ id: 'r-1' });
  (assertRoundBundlesVersion as Mock).mockResolvedValue(true);
  (loadVersionForSuggest as Mock).mockResolvedValue({
    goal: 'Goal',
    questions: [{ id: 'q1', prompt: 'Q1?', sectionTitle: 'S' }],
  });
  (loadComposerAgent as Mock).mockResolvedValue({ ok: true, value: AGENT });
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: { entries: [{ questionId: 'q1', title: 'T', content: 'C' }] },
  });
});

describe('POST …/context/suggest', () => {
  it('returns proposals with questionId renamed to questionSlotId', async () => {
    const res = await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.entries).toEqual([{ questionSlotId: 'q1', title: 'T', content: 'C' }]);
  });

  it('passes the version goal + questions to the capability dispatch', async () => {
    await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx);
    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args.goal).toBe('Goal');
    expect(args.questions).toHaveLength(1);
  });

  it('400s when the version is not bundled in the round', async () => {
    (assertRoundBundlesVersion as Mock).mockResolvedValue(false);
    const res = await suggestPost(jsonReq({ versionId: 'v-9' }), ADMIN, ctx);
    expect(res.status).toBe(400);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('400s when the version has no questions', async () => {
    (loadVersionForSuggest as Mock).mockResolvedValue({ goal: null, questions: [] });
    const res = await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx);
    expect(res.status).toBe(400);
  });

  it('maps dispatch error codes to statuses (503 / 429 / 400)', async () => {
    for (const [code, status] of [
      ['provider_unavailable', 503],
      ['rate_limited', 429],
      ['invalid_args', 400],
    ] as const) {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: false,
        error: { code, message: 'x' },
      });
      expect((await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx)).status).toBe(status);
    }
  });

  it('429s when the per-admin sub-cap is exceeded (before any dispatch)', async () => {
    (composeLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx);
    expect(res.status).toBe(429);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('surfaces the composer-not-configured response without dispatching', async () => {
    (loadComposerAgent as Mock).mockResolvedValue({
      ok: false,
      response: new Response('no agent', { status: 503 }),
    });
    const res = await suggestPost(jsonReq({ versionId: 'v-1' }), ADMIN, ctx);
    expect(res.status).toBe(503);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('400s an invalid body (missing versionId)', async () => {
    expect((await suggestPost(jsonReq({}), ADMIN, ctx)).status).toBe(400);
  });
});

describe('POST …/context/parse', () => {
  it('returns extracted text', async () => {
    (parseDocument as Mock).mockResolvedValue({ fullText: '  Revenue was £4m.  ' });
    const file = new File(['x'], 'brief.txt', { type: 'text/plain' });
    const res = await parsePost(uploadReq(file), ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.text).toBe('Revenue was £4m.');
  });

  it('422s when the document yields no text', async () => {
    (parseDocument as Mock).mockResolvedValue({ fullText: '   ' });
    const file = new File(['x'], 'empty.txt', { type: 'text/plain' });
    const res = await parsePost(uploadReq(file), ADMIN);
    expect(res.status).toBe(422);
  });

  it('422s when the parser throws', async () => {
    (parseDocument as Mock).mockRejectedValue(new Error('corrupt pdf'));
    const file = new File(['x'], 'bad.pdf', { type: 'application/pdf' });
    const res = await parsePost(uploadReq(file), ADMIN);
    expect(res.status).toBe(422);
  });

  it('429s when the ingest sub-cap is exceeded (before parsing)', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const file = new File(['x'], 'brief.txt', { type: 'text/plain' });
    const res = await parsePost(uploadReq(file), ADMIN);
    expect(res.status).toBe(429);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('rejects a missing file via the upload guard', async () => {
    const res = await parsePost(uploadReq(null), ADMIN);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(parseDocument).not.toHaveBeenCalled();
  });
});
