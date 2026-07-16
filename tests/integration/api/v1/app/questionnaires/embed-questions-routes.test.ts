/**
 * Integration test: question-slot embedding backfill route (F4.1 / PR3).
 *
 * Exercises the POST handler with the version scope (`prisma`) and the embedding
 * service mocked: gate order (404 flag-off before auth), 401/403, scope-404, the
 * happy path (returns the embed counts, honours `force`), and that the embedding
 * work runs only after scope + rate-limit pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  embedVersionSlots: vi.fn(),
  slotEmbeddingCoverage: vi.fn(),
}));

// The backfill sub-cap is a module-singleton sliding-window limiter. Mock it so
// tests don't consume real tokens (no cross-test window-state leak) and so the
// 429 path is drivable. Default: allow; a test overrides per-call to deny.
const rateLimitMock = vi.hoisted(() => ({
  embedSlotsLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  GET,
  POST,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/embed-questions/route';

import { auth } from '@/lib/auth/config';
import {
  embedVersionSlots,
  slotEmbeddingCoverage,
} from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/embed-questions';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  (embedVersionSlots as unknown as Mock).mockResolvedValue({ embedded: 2, skipped: 1, total: 3 });
  (slotEmbeddingCoverage as unknown as Mock).mockResolvedValue({
    total: 3,
    embedded: 2,
    missing: 1,
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(403);
  });

  it('404s on a version/questionnaire scope mismatch, before embedding', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(embedVersionSlots).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });

  it('400s on a malformed body without embedding', async () => {
    const res = await POST(req({ force: 'yes' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(embedVersionSlots).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('429s when the per-admin sub-cap is exceeded, before embedding', async () => {
    rateLimitMock.embedSlotsLimiter.check.mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 1_700_000_000_000,
    });
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(embedVersionSlots).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it('embeds missing slots by default and returns the counts', async () => {
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ embedded: 2, skipped: 1, total: 3 });
    expect(embedVersionSlots).toHaveBeenCalledWith('v1', { onlyMissing: true });
  });

  it('re-embeds all slots when force is set', async () => {
    (embedVersionSlots as unknown as Mock).mockResolvedValue({ embedded: 3, skipped: 0, total: 3 });
    const res = await POST(req({ force: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ embedded: 3, skipped: 0, total: 3 });
    expect(embedVersionSlots).toHaveBeenCalledWith('v1', { onlyMissing: false });
  });
});

describe('GET coverage', () => {
  it('returns the version embedding coverage', async () => {
    const res = await GET(req({}), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ total: 3, embedded: 2, missing: 1 });
    expect(slotEmbeddingCoverage).toHaveBeenCalledWith('v1');
  });

  it('404s on a scope mismatch without reading coverage', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await GET(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(slotEmbeddingCoverage).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await GET(req({}), ctx(PARAMS))).status).toBe(403);
  });
});
