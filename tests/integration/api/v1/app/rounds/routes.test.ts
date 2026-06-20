/**
 * Integration: round routes — create (default name derivation), the manual close action
 * (incl. the already-closed 409), and the cohorts flag gate. DB seam + read model mocked.
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
  appCohort: { findUnique: vi.fn() },
  appQuestionnaireRound: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/rounds/_lib/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/rounds/_lib/read')>();
  return { ...real, listRounds: vi.fn(), getRoundDetail: vi.fn() };
});

import { POST as createPOST } from '@/app/api/v1/app/rounds/route';
import { POST as closePOST } from '@/app/api/v1/app/rounds/[id]/close/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const ROUNDS_URL = 'http://localhost:3000/api/v1/app/rounds';

function jsonReq(body: unknown, url = ROUNDS_URL): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
function postReq(url: string): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (getRoundDetail as unknown as Mock).mockResolvedValue({ id: 'r-1' });
});

describe('POST /api/v1/app/rounds', () => {
  it('derives a default name from the cohort + window when name omitted', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'co-1', name: 'Acme Team' });
    prismaMock.appQuestionnaireRound.create.mockResolvedValue({ id: 'r-1', name: 'x' });

    const res = await createPOST(
      jsonReq({
        cohortId: 'co-1',
        opensAt: '2026-07-01T00:00:00.000Z',
        closesAt: '2026-07-31T00:00:00.000Z',
      })
    );
    expect(res.status).toBe(201);
    const data = prismaMock.appQuestionnaireRound.create.mock.calls[0][0].data;
    expect(data.name).toBe('Acme Team · 1 Jul 2026 – 31 Jul 2026');
  });

  it('404s when the cohort is unknown', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    const res = await createPOST(jsonReq({ cohortId: 'nope' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/app/rounds/:id/close', () => {
  const ctx = { params: Promise.resolve({ id: 'r-1' }) };
  const url = `${ROUNDS_URL}/r-1/close`;

  it('404s when the cohorts flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await closePOST(postReq(url), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('closes an open round and audits it', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      name: 'Round',
      status: 'open',
    });
    prismaMock.appQuestionnaireRound.update.mockResolvedValue({});

    const res = await closePOST(postReq(url), ctx);
    expect(res.status).toBe(200);
    const data = prismaMock.appQuestionnaireRound.update.mock.calls[0][0].data;
    expect(data.status).toBe('closed');
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.closedBy).toBeTruthy();
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_round.close' })
    );
  });

  it('409s an already-closed round', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      name: 'Round',
      status: 'closed',
    });
    const res = await closePOST(postReq(url), ctx);
    expect(res.status).toBe(409);
    expect(prismaMock.appQuestionnaireRound.update).not.toHaveBeenCalled();
  });
});
