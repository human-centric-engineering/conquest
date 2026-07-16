/**
 * Integration: cohort member PATCH — the subgroup-assignment branch added for round phasing.
 * A non-null subgroupId must belong to the SAME cohort (else 422); null unassigns. DB seam mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  appCohortMember: { findFirst: vi.fn(), update: vi.fn() },
  appCohortSubgroup: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { PATCH, DELETE } from '@/app/api/v1/app/cohorts/[id]/members/[memberId]/route';
import { auth } from '@/lib/auth/config';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const ctx = { params: Promise.resolve({ id: 'c-1', memberId: 'm-1' }) };

const MEMBER = {
  id: 'm-1',
  cohortId: 'c-1',
  subgroupId: null,
  email: 'a@x.com',
  name: 'A',
  notes: null,
  status: 'active',
  addedAt: new Date('2026-06-01'),
  removedAt: null,
};

function jsonReq(body: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/cohorts/c-1/members/m-1',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
function plainReq(): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/cohorts/c-1/members/m-1',
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appCohortMember.findFirst.mockResolvedValue(MEMBER);
  prismaMock.appCohortMember.update.mockResolvedValue({ ...MEMBER, subgroupId: 'sg-1' });
  prismaMock.appCohortSubgroup.findFirst.mockResolvedValue({ id: 'sg-1' });
});

describe('PATCH member subgroup assignment', () => {
  it('assigns a subgroup that belongs to the cohort', async () => {
    const res = await PATCH(jsonReq({ subgroupId: 'sg-1' }), ctx);
    expect(res.status).toBe(200);
    expect(prismaMock.appCohortSubgroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sg-1', cohortId: 'c-1' } })
    );
    expect(prismaMock.appCohortMember.update.mock.calls[0][0].data).toMatchObject({
      subgroupId: 'sg-1',
    });
  });

  it('422s a subgroup from a different cohort', async () => {
    prismaMock.appCohortSubgroup.findFirst.mockResolvedValue(null);
    const res = await PATCH(jsonReq({ subgroupId: 'sg-other' }), ctx);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('SUBGROUP_NOT_IN_COHORT');
    expect(prismaMock.appCohortMember.update).not.toHaveBeenCalled();
  });

  it('unassigns with subgroupId: null (no membership check)', async () => {
    prismaMock.appCohortMember.update.mockResolvedValue({ ...MEMBER, subgroupId: null });
    const res = await PATCH(jsonReq({ subgroupId: null }), ctx);
    expect(res.status).toBe(200);
    expect(prismaMock.appCohortSubgroup.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.appCohortMember.update.mock.calls[0][0].data).toMatchObject({
      subgroupId: null,
    });
  });

  it('404s an unknown member before any subgroup work', async () => {
    prismaMock.appCohortMember.findFirst.mockResolvedValue(null);
    const res = await PATCH(jsonReq({ subgroupId: 'sg-1' }), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.appCohortSubgroup.findFirst).not.toHaveBeenCalled();
  });
});

describe('DELETE member (soft remove)', () => {
  it('soft-removes the member (status removed + removedAt)', async () => {
    prismaMock.appCohortMember.update.mockResolvedValue({
      ...MEMBER,
      status: 'removed',
      removedAt: new Date('2026-06-21'),
    });
    const res = await DELETE(plainReq(), ctx);
    expect(res.status).toBe(200);
    expect(prismaMock.appCohortMember.update.mock.calls[0][0].data).toMatchObject({
      status: 'removed',
      removedAt: expect.any(Date),
    });
  });

  it('404s an unknown member', async () => {
    prismaMock.appCohortMember.findFirst.mockResolvedValue(null);
    const res = await DELETE(plainReq(), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.appCohortMember.update).not.toHaveBeenCalled();
  });
});
