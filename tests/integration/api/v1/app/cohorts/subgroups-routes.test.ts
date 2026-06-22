/**
 * Integration: cohort subgroup routes — list / create / update / delete, the round-phases flag gate,
 * the cohort-membership 404s, and the unique-name 409. DB seam + read model mocked.
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
  appCohort: { findUnique: vi.fn() },
  appCohortSubgroup: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/cohorts/_lib/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/cohorts/_lib/read')>();
  return { ...real, listCohortSubgroups: vi.fn() };
});

import { GET as listGET, POST as createPOST } from '@/app/api/v1/app/cohorts/[id]/subgroups/route';
import {
  PATCH as updatePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/v1/app/cohorts/[id]/subgroups/[subgroupId]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { listCohortSubgroups } from '@/app/api/v1/app/cohorts/_lib/read';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const BASE = 'http://localhost:3000/api/v1/app/cohorts/c-1/subgroups';

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

const collCtx = { params: Promise.resolve({ id: 'c-1' }) };
const itemCtx = { params: Promise.resolve({ id: 'c-1', subgroupId: 'sg-1' }) };

const SUBGROUP_ROW = {
  id: 'sg-1',
  cohortId: 'c-1',
  name: 'Senior Leadership Team',
  description: null,
  ordinal: 0,
  createdAt: new Date('2026-06-01'),
  updatedAt: new Date('2026-06-01'),
  _count: { members: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true); // master AND cohorts AND round-phases on
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'c-1' });
  prismaMock.appCohortSubgroup.create.mockResolvedValue(SUBGROUP_ROW);
  prismaMock.appCohortSubgroup.findFirst.mockResolvedValue(SUBGROUP_ROW);
  prismaMock.appCohortSubgroup.update.mockResolvedValue({ ...SUBGROUP_ROW, name: 'Renamed' });
  prismaMock.appCohortSubgroup.delete.mockResolvedValue(SUBGROUP_ROW);
  (listCohortSubgroups as Mock).mockResolvedValue([]);
});

describe('GET /cohorts/:id/subgroups', () => {
  it('404s before auth when the round-phases flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await listGET(getReq(), collCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('lists the cohort subgroups', async () => {
    (listCohortSubgroups as Mock).mockResolvedValue([{ id: 'sg-1', name: 'SLT' }]);
    const res = await listGET(getReq(), collCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: 'sg-1', name: 'SLT' }]);
  });

  it('404s an unknown cohort', async () => {
    (listCohortSubgroups as Mock).mockResolvedValue(null);
    const res = await listGET(getReq(), collCtx);
    expect(res.status).toBe(404);
  });
});

describe('POST /cohorts/:id/subgroups', () => {
  it('creates a subgroup (201) stamped with createdBy', async () => {
    const res = await createPOST(jsonReq({ name: 'Senior Leadership Team' }), collCtx);
    expect(res.status).toBe(201);
    expect(prismaMock.appCohortSubgroup.create.mock.calls[0][0].data).toMatchObject({
      cohortId: 'c-1',
      name: 'Senior Leadership Team',
    });
  });

  it('404s an unknown cohort before creating', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    const res = await createPOST(jsonReq({ name: 'X' }), collCtx);
    expect(res.status).toBe(404);
    expect(prismaMock.appCohortSubgroup.create).not.toHaveBeenCalled();
  });

  it('400s a blank name (schema validation)', async () => {
    const res = await createPOST(jsonReq({ name: '   ' }), collCtx);
    expect(res.status).toBe(400);
  });

  it('409s a duplicate name (unique violation)', async () => {
    prismaMock.appCohortSubgroup.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );
    const res = await createPOST(jsonReq({ name: 'SLT' }), collCtx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SUBGROUP_ALREADY_EXISTS');
  });
});

describe('PATCH /cohorts/:id/subgroups/:subgroupId', () => {
  it('renames a subgroup', async () => {
    const res = await updatePATCH(jsonReq({ name: 'Renamed' }), itemCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appCohortSubgroup.update.mock.calls[0][0].data).toMatchObject({
      name: 'Renamed',
    });
  });

  it('404s a subgroup not in the cohort', async () => {
    prismaMock.appCohortSubgroup.findFirst.mockResolvedValue(null);
    const res = await updatePATCH(jsonReq({ name: 'X' }), itemCtx);
    expect(res.status).toBe(404);
  });

  it('404s before auth when the round-phases flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await updatePATCH(jsonReq({ name: 'X' }), itemCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('409s a rename collision', async () => {
    prismaMock.appCohortSubgroup.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );
    const res = await updatePATCH(jsonReq({ name: 'Taken' }), itemCtx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SUBGROUP_ALREADY_EXISTS');
  });
});

describe('DELETE /cohorts/:id/subgroups/:subgroupId', () => {
  it('deletes the subgroup', async () => {
    const res = await deleteDELETE(getReq(), itemCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appCohortSubgroup.delete).toHaveBeenCalledWith({ where: { id: 'sg-1' } });
  });

  it('404s a subgroup not in the cohort', async () => {
    prismaMock.appCohortSubgroup.findFirst.mockResolvedValue(null);
    const res = await deleteDELETE(getReq(), itemCtx);
    expect(res.status).toBe(404);
    expect(prismaMock.appCohortSubgroup.delete).not.toHaveBeenCalled();
  });

  it('404s before auth when the round-phases flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await deleteDELETE(getReq(), itemCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(prismaMock.appCohortSubgroup.delete).not.toHaveBeenCalled();
  });
});
