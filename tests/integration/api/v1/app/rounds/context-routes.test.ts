/**
 * Integration: round Additional Context ("briefing") routes — list / create / update / delete,
 * the round-context flag gate, and the version/question membership validations. DB seam + read
 * model mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireRound: { findUnique: vi.fn() },
  appRoundContextEntry: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/rounds/_lib/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/rounds/_lib/context')>();
  return {
    ...real,
    listRoundContextEntries: vi.fn(),
    getRoundContextEntry: vi.fn(),
    assertRoundBundlesVersion: vi.fn(),
    assertSlotInVersion: vi.fn(),
  };
});

import { GET as listGET, POST as createPOST } from '@/app/api/v1/app/rounds/[id]/context/route';
import {
  PATCH as updatePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/v1/app/rounds/[id]/context/[entryId]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  assertRoundBundlesVersion,
  assertSlotInVersion,
  getRoundContextEntry,
  listRoundContextEntries,
} from '@/app/api/v1/app/rounds/_lib/context';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const BASE = 'http://localhost:3000/api/v1/app/rounds/r-1/context';

function jsonReq(body: unknown, url = BASE): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
function getReq(url = BASE): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

const collCtx = { params: Promise.resolve({ id: 'r-1' }) };
const entryCtx = { params: Promise.resolve({ id: 'r-1', entryId: 'e-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  // All three flags on (master AND cohorts AND round-context) → gate open.
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({ id: 'r-1', name: 'July round' });
  (assertRoundBundlesVersion as unknown as Mock).mockResolvedValue(true);
  (assertSlotInVersion as unknown as Mock).mockResolvedValue(true);
  (getRoundContextEntry as unknown as Mock).mockResolvedValue({ id: 'e-1', title: 'Fact' });
});

describe('GET /api/v1/app/rounds/:id/context', () => {
  it('404s before auth when the round-context flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await listGET(getReq(), collCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('returns the round entries', async () => {
    (listRoundContextEntries as unknown as Mock).mockResolvedValue([{ id: 'e-1', title: 'Fact' }]);
    const res = await listGET(getReq(), collCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.entries).toEqual([{ id: 'e-1', title: 'Fact' }]);
  });
});

describe('POST /api/v1/app/rounds/:id/context', () => {
  const valid = { versionId: 'v-1', title: 'Revenue', content: '£4m ARR' };

  it('creates a general briefing entry', async () => {
    prismaMock.appRoundContextEntry.create.mockResolvedValue({ id: 'e-1' });
    const res = await createPOST(jsonReq(valid), collCtx);
    expect(res.status).toBe(201);
    expect(prismaMock.appRoundContextEntry.create).toHaveBeenCalled();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('400s when the version is not bundled in the round', async () => {
    (assertRoundBundlesVersion as unknown as Mock).mockResolvedValue(false);
    const res = await createPOST(jsonReq(valid), collCtx);
    expect(res.status).toBe(400);
    expect(prismaMock.appRoundContextEntry.create).not.toHaveBeenCalled();
  });

  it('400s when an attributed question is not in the version', async () => {
    (assertSlotInVersion as unknown as Mock).mockResolvedValue(false);
    const res = await createPOST(jsonReq({ ...valid, questionSlotId: 'q-9' }), collCtx);
    expect(res.status).toBe(400);
    expect(prismaMock.appRoundContextEntry.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (missing content)', async () => {
    const res = await createPOST(jsonReq({ versionId: 'v-1', title: 'x' }), collCtx);
    expect(res.status).toBe(400);
    expect(prismaMock.appRoundContextEntry.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/app/rounds/:id/context/:entryId', () => {
  it('404s an unknown entry', async () => {
    prismaMock.appRoundContextEntry.findFirst.mockResolvedValue(null);
    const res = await updatePATCH(jsonReq({ title: 'New' }), entryCtx);
    expect(res.status).toBe(404);
  });

  it('updates an existing entry', async () => {
    prismaMock.appRoundContextEntry.findFirst.mockResolvedValue({
      id: 'e-1',
      versionId: 'v-1',
      questionSlotId: null,
      title: 'Old',
      content: 'c',
      ordinal: 0,
    });
    prismaMock.appRoundContextEntry.update.mockResolvedValue({
      id: 'e-1',
      versionId: 'v-1',
      questionSlotId: null,
      title: 'New',
      content: 'c',
      ordinal: 0,
    });
    const res = await updatePATCH(jsonReq({ title: 'New' }), entryCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appRoundContextEntry.update).toHaveBeenCalled();
    expect((await res.json()).success).toBe(true);
  });

  it('400s a re-attribution to a question outside the version', async () => {
    prismaMock.appRoundContextEntry.findFirst.mockResolvedValue({
      id: 'e-1',
      versionId: 'v-1',
      questionSlotId: null,
      title: 'Old',
      content: 'c',
      ordinal: 0,
    });
    (assertSlotInVersion as unknown as Mock).mockResolvedValue(false);
    const res = await updatePATCH(jsonReq({ questionSlotId: 'q-9' }), entryCtx);
    expect(res.status).toBe(400);
    expect(prismaMock.appRoundContextEntry.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/app/rounds/:id/context/:entryId', () => {
  it('deletes an existing entry', async () => {
    prismaMock.appRoundContextEntry.findFirst.mockResolvedValue({ id: 'e-1', title: 'Fact' });
    prismaMock.appRoundContextEntry.delete.mockResolvedValue({});
    const res = await deleteDELETE(getReq(`${BASE}/e-1`), entryCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appRoundContextEntry.delete).toHaveBeenCalledWith({ where: { id: 'e-1' } });
    expect(await res.json()).toEqual({ success: true, data: { id: 'e-1', deleted: true } });
  });

  it('404s an unknown entry', async () => {
    prismaMock.appRoundContextEntry.findFirst.mockResolvedValue(null);
    const res = await deleteDELETE(getReq(`${BASE}/e-1`), entryCtx);
    expect(res.status).toBe(404);
    expect(prismaMock.appRoundContextEntry.delete).not.toHaveBeenCalled();
  });
});
