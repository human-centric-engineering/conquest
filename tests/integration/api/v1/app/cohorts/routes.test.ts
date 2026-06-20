/**
 * Integration: cohort CRUD routes.
 *
 * Exercises the HTTP orchestration with the DB seam mocked — the cohorts flag gate (404 before
 * auth), the required-demoClientId list guard, create (incl. the unknown-demo-client 404), the
 * member roster add + duplicate-email 409, and audit emission. Read-model projections are
 * mocked here; they're unit-tested elsewhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

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
  appCohort: { create: vi.fn(), findUnique: vi.fn() },
  appCohortMember: { create: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/cohorts/_lib/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/cohorts/_lib/read')>();
  return {
    ...real,
    listCohorts: vi.fn(),
    getCohortDetail: vi.fn(),
    listCohortMembers: vi.fn(),
    demoClientExists: vi.fn(),
  };
});

import { GET as listGET, POST as createPOST } from '@/app/api/v1/app/cohorts/route';
import { POST as addMemberPOST } from '@/app/api/v1/app/cohorts/[id]/members/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { listCohorts, getCohortDetail, demoClientExists } from '@/app/api/v1/app/cohorts/_lib/read';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function getReq(url: string): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}
function jsonReq(body: unknown, url: string): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
function setAuth(s: ReturnType<typeof mockAdminUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const COHORTS_URL = 'http://localhost:3000/api/v1/app/cohorts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAdminUser());
});

describe('GET /api/v1/app/cohorts', () => {
  it('404s when the cohorts flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await listGET(getReq(`${COHORTS_URL}?demoClientId=dc-1`));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await listGET(getReq(`${COHORTS_URL}?demoClientId=dc-1`));
    expect(res.status).toBe(401);
  });

  it('400s without demoClientId', async () => {
    const res = await listGET(getReq(COHORTS_URL));
    expect(res.status).toBe(400);
  });

  it('lists a client’s cohorts', async () => {
    (listCohorts as unknown as Mock).mockResolvedValue([{ id: 'co-1', name: 'Team' }]);
    const res = await listGET(getReq(`${COHORTS_URL}?demoClientId=dc-1`));
    expect(res.status).toBe(200);
    expect(listCohorts).toHaveBeenCalledWith('dc-1', undefined);
  });
});

describe('POST /api/v1/app/cohorts', () => {
  it('creates a cohort and audits it', async () => {
    (demoClientExists as unknown as Mock).mockResolvedValue(true);
    prismaMock.appCohort.create.mockResolvedValue({ id: 'co-9', name: 'Leadership' });
    (getCohortDetail as unknown as Mock).mockResolvedValue({ id: 'co-9', name: 'Leadership' });

    const res = await createPOST(
      jsonReq({ demoClientId: 'dc-1', name: 'Leadership' }, COHORTS_URL)
    );
    expect(res.status).toBe(201);
    expect(prismaMock.appCohort.create).toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_cohort.create', entityId: 'co-9' })
    );
  });

  it('404s when the demo client does not exist', async () => {
    (demoClientExists as unknown as Mock).mockResolvedValue(false);
    const res = await createPOST(jsonReq({ demoClientId: 'nope', name: 'X' }, COHORTS_URL));
    expect(res.status).toBe(404);
    expect(prismaMock.appCohort.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/app/cohorts/:id/members', () => {
  const url = 'http://localhost:3000/api/v1/app/cohorts/co-1/members';
  const ctx = { params: Promise.resolve({ id: 'co-1' }) };

  it('adds a member', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'co-1' });
    prismaMock.appCohortMember.create.mockResolvedValue({
      id: 'm-1',
      cohortId: 'co-1',
      email: 'jo@acme.com',
      name: 'Jo',
      notes: null,
      status: 'active',
      addedAt: new Date(),
      removedAt: null,
    });

    const res = await addMemberPOST(jsonReq({ email: 'jo@acme.com', name: 'Jo' }, url), ctx);
    expect(res.status).toBe(201);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_cohort_member.add' })
    );
  });

  it('409s a duplicate email on the roster', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'co-1' });
    prismaMock.appCohortMember.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      })
    );
    const res = await addMemberPOST(jsonReq({ email: 'jo@acme.com', name: 'Jo' }, url), ctx);
    expect(res.status).toBe(409);
  });

  it('404s when the cohort is unknown', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    const res = await addMemberPOST(jsonReq({ email: 'jo@acme.com', name: 'Jo' }, url), ctx);
    expect(res.status).toBe(404);
  });
});
