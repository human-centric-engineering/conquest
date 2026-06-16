/**
 * Integration test: data-slot embedding route (adaptive data-slot selection).
 *
 * The data-slot analogue of `embed-questions-routes.test.ts`. Exercises the GET (coverage) + POST
 * (generate) handlers with the version scope (`prisma`) and the embedding service mocked: gate order
 * (404 flag-off before auth), 401/403, scope-404, the happy paths (coverage; embed counts honouring
 * `force`), and that the embedding work runs only after scope + rate-limit pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => ({
  embedVersionDataSlots: vi.fn(),
  dataSlotEmbeddingCoverage: vi.fn(),
}));

const rateLimitMock = vi.hoisted(() => ({
  embedSlotsLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

import {
  GET,
  POST,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/embed-data-slots/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  dataSlotEmbeddingCoverage,
  embedVersionDataSlots,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/embed-data-slots';

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
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  (embedVersionDataSlots as unknown as Mock).mockResolvedValue({
    embedded: 2,
    skipped: 1,
    total: 3,
  });
  (dataSlotEmbeddingCoverage as unknown as Mock).mockResolvedValue({
    total: 3,
    embedded: 2,
    missing: 1,
  });
});

describe('GET coverage', () => {
  it('returns the data-slot embedding coverage', async () => {
    const res = await GET(req({}), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ total: 3, embedded: 2, missing: 1 });
    expect(dataSlotEmbeddingCoverage).toHaveBeenCalledWith('v1');
  });

  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await GET(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await GET(req({}), ctx(PARAMS))).status).toBe(403);
  });
});

describe('POST generate — gate order + auth', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(401);
  });

  it('404s on a scope mismatch, before embedding', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(embedVersionDataSlots).not.toHaveBeenCalled();
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
    expect(embedVersionDataSlots).not.toHaveBeenCalled();
  });
});

describe('POST generate — happy path', () => {
  it('embeds missing slots by default and returns the counts', async () => {
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ embedded: 2, skipped: 1, total: 3 });
    expect(embedVersionDataSlots).toHaveBeenCalledWith('v1', { onlyMissing: true });
  });

  it('re-embeds all slots when force is set', async () => {
    (embedVersionDataSlots as unknown as Mock).mockResolvedValue({
      embedded: 3,
      skipped: 0,
      total: 3,
    });
    const res = await POST(req({ force: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(embedVersionDataSlots).toHaveBeenCalledWith('v1', { onlyMissing: false });
  });
});
