/**
 * Integration: round phase routes — list / create / update / delete, the per-phase send-invites
 * action, and the maintenance dispatch hook. Covers the cohort-membership
 * + window-nesting 422s, the unique-phase 409, and the staggered-send wiring. DB seam, read model, and
 * invite generator mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

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
  appCohortSubgroup: { findFirst: vi.fn() },
  appRoundPhase: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/rounds/_lib/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/rounds/_lib/read')>();
  return { ...real, getRoundDetail: vi.fn() };
});

vi.mock('@/app/api/v1/app/rounds/_lib/invites', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/rounds/_lib/invites')>();
  return {
    ...real,
    generateRoundInvitations: vi.fn(),
    dispatchDuePhaseInvitations: vi.fn(),
  };
});

import { GET as listGET, POST as createPOST } from '@/app/api/v1/app/rounds/[id]/phases/route';
import {
  PATCH as updatePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/v1/app/rounds/[id]/phases/[phaseId]/route';
import { POST as sendPOST } from '@/app/api/v1/app/rounds/[id]/phases/[phaseId]/send-invites/route';
import { POST as dispatchPOST } from '@/app/api/v1/app/rounds/maintenance/dispatch-phase-invites/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getRoundDetail } from '@/app/api/v1/app/rounds/_lib/read';
import {
  generateRoundInvitations,
  dispatchDuePhaseInvitations,
} from '@/app/api/v1/app/rounds/_lib/invites';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const BASE = 'http://localhost:3000/api/v1/app/rounds/r-1/phases';

function jsonReq(body: unknown, url = BASE): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
function plainReq(url = BASE): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

const collCtx = { params: Promise.resolve({ id: 'r-1' }) };
const itemCtx = { params: Promise.resolve({ id: 'r-1', phaseId: 'ph-1' }) };

const ROUND = { id: 'r-1', name: 'July', cohortId: 'c-1', opensAt: null, closesAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(ROUND);
  prismaMock.appCohortSubgroup.findFirst.mockResolvedValue({ id: 'sg-1', name: 'SLT' });
  prismaMock.appRoundPhase.create.mockResolvedValue({ id: 'ph-1' });
  prismaMock.appRoundPhase.findFirst.mockResolvedValue({
    id: 'ph-1',
    subgroupId: 'sg-1',
    opensAt: null,
    closesAt: null,
    endMode: 'hard',
    ordinal: 0,
    round: { name: 'July', opensAt: null, closesAt: null },
  });
  prismaMock.appRoundPhase.update.mockResolvedValue({
    id: 'ph-1',
    opensAt: null,
    closesAt: null,
    endMode: 'relaxed',
    ordinal: 0,
  });
  prismaMock.appRoundPhase.delete.mockResolvedValue({ id: 'ph-1' });
  (getRoundDetail as Mock).mockResolvedValue({ id: 'r-1', phases: [] });
  (generateRoundInvitations as Mock).mockResolvedValue({
    created: 2,
    sent: 2,
    skipped: 0,
    unlaunchedQuestionnaires: 0,
    activeMembers: 2,
    links: [],
  });
  (dispatchDuePhaseInvitations as Mock).mockResolvedValue({
    phasesProcessed: 1,
    created: 2,
    sent: 2,
  });
});

describe('GET /rounds/:id/phases', () => {
  it('returns the round phases', async () => {
    (getRoundDetail as Mock).mockResolvedValue({ id: 'r-1', phases: [{ id: 'ph-1' }] });
    const res = await listGET(plainReq(), collCtx);
    expect((await res.json()).data).toEqual([{ id: 'ph-1' }]);
  });

  it('404s an unknown round', async () => {
    (getRoundDetail as Mock).mockResolvedValue(null);
    const res = await listGET(plainReq(), collCtx);
    expect(res.status).toBe(404);
  });
});

describe('POST /rounds/:id/phases', () => {
  it('creates a phase (201)', async () => {
    const res = await createPOST(jsonReq({ subgroupId: 'sg-1', endMode: 'hard' }), collCtx);
    expect(res.status).toBe(201);
    expect((await res.json()).success).toBe(true);
    expect(prismaMock.appRoundPhase.create.mock.calls[0][0].data).toMatchObject({
      roundId: 'r-1',
      subgroupId: 'sg-1',
      endMode: 'hard',
    });
  });

  it('404s an unknown round before creating', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    const res = await createPOST(jsonReq({ subgroupId: 'sg-1' }), collCtx);
    expect(res.status).toBe(404);
    expect(prismaMock.appRoundPhase.create).not.toHaveBeenCalled();
  });

  it('422s a subgroup outside the round cohort', async () => {
    prismaMock.appCohortSubgroup.findFirst.mockResolvedValue(null);
    const res = await createPOST(jsonReq({ subgroupId: 'sg-x' }), collCtx);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('SUBGROUP_NOT_IN_COHORT');
  });

  it('422s a window that does not nest inside the round window', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      ...ROUND,
      opensAt: new Date('2026-07-01T00:00:00Z'),
      closesAt: new Date('2026-07-31T00:00:00Z'),
    });
    const res = await createPOST(
      jsonReq({ subgroupId: 'sg-1', closesAt: '2026-08-15T00:00:00Z' }), // past round close
      collCtx
    );
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('PHASE_WINDOW_NOT_NESTED');
  });

  it('409s when the subgroup already has a phase', async () => {
    prismaMock.appRoundPhase.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );
    const res = await createPOST(jsonReq({ subgroupId: 'sg-1' }), collCtx);
    expect((await res.json()).error.code).toBe('PHASE_ALREADY_EXISTS');
  });
});

describe('PATCH /rounds/:id/phases/:phaseId', () => {
  it('updates a phase', async () => {
    const res = await updatePATCH(jsonReq({ endMode: 'relaxed' }), itemCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appRoundPhase.update.mock.calls[0][0].data).toMatchObject({
      endMode: 'relaxed',
    });
  });

  it('applies window + ordinal fields together (within the round window)', async () => {
    prismaMock.appRoundPhase.findFirst.mockResolvedValue({
      id: 'ph-1',
      subgroupId: 'sg-1',
      opensAt: null,
      closesAt: null,
      endMode: 'hard',
      ordinal: 0,
      round: {
        name: 'July',
        opensAt: new Date('2026-07-01T00:00:00Z'),
        closesAt: new Date('2026-07-31T00:00:00Z'),
      },
    });
    const res = await updatePATCH(
      jsonReq({ opensAt: '2026-07-02T00:00:00Z', closesAt: '2026-07-10T00:00:00Z', ordinal: 2 }),
      itemCtx
    );
    expect(res.status).toBe(200);
    const data = prismaMock.appRoundPhase.update.mock.calls[0][0].data;
    expect(data.ordinal).toBe(2);
    expect(data.opensAt).toEqual(new Date('2026-07-02T00:00:00Z'));
    expect(data.closesAt).toEqual(new Date('2026-07-10T00:00:00Z'));
  });

  it('404s a phase not on the round', async () => {
    prismaMock.appRoundPhase.findFirst.mockResolvedValue(null);
    const res = await updatePATCH(jsonReq({ endMode: 'relaxed' }), itemCtx);
    expect(res.status).toBe(404);
  });

  it('422s a patch that breaks window nesting', async () => {
    prismaMock.appRoundPhase.findFirst.mockResolvedValue({
      id: 'ph-1',
      subgroupId: 'sg-1',
      opensAt: null,
      closesAt: null,
      endMode: 'hard',
      ordinal: 0,
      round: {
        name: 'July',
        opensAt: new Date('2026-07-01T00:00:00Z'),
        closesAt: new Date('2026-07-31T00:00:00Z'),
      },
    });
    const res = await updatePATCH(jsonReq({ opensAt: '2026-06-01T00:00:00Z' }), itemCtx); // before round open
    expect((await res.json()).error.code).toBe('PHASE_WINDOW_NOT_NESTED');
  });
});

describe('DELETE /rounds/:id/phases/:phaseId', () => {
  it('deletes the phase', async () => {
    const res = await deleteDELETE(plainReq(), itemCtx);
    expect(res.status).toBe(200);
    expect(prismaMock.appRoundPhase.delete).toHaveBeenCalledWith({ where: { id: 'ph-1' } });
  });

  it('404s a phase not on the round', async () => {
    prismaMock.appRoundPhase.findFirst.mockResolvedValue(null);
    const res = await deleteDELETE(plainReq(), itemCtx);
    expect(res.status).toBe(404);
    expect(prismaMock.appRoundPhase.delete).not.toHaveBeenCalled();
  });
});

describe('POST /rounds/:id/phases/:phaseId/send-invites', () => {
  it('generates + sends only this subgroup’s invitations', async () => {
    const res = await sendPOST(plainReq(), itemCtx);
    expect(res.status).toBe(201);
    expect(generateRoundInvitations).toHaveBeenCalledWith('r-1', expect.any(String), {
      subgroupId: 'sg-1',
      send: true,
    });
  });

  it('404s a phase not on the round', async () => {
    prismaMock.appRoundPhase.findFirst.mockResolvedValue(null);
    const res = await sendPOST(plainReq(), itemCtx);
    expect(res.status).toBe(404);
    expect(generateRoundInvitations).not.toHaveBeenCalled();
  });
});

describe('POST /rounds/maintenance/dispatch-phase-invites', () => {
  it('dispatches due phases and returns the summary', async () => {
    const res = await dispatchPOST(plainReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ phasesProcessed: 1, created: 2, sent: 2 });
    expect(dispatchDuePhaseInvitations).toHaveBeenCalledWith(expect.any(String));
  });

  it('is a quiet 200 with no audit when nothing was due', async () => {
    (dispatchDuePhaseInvitations as Mock).mockResolvedValue({
      phasesProcessed: 0,
      created: 0,
      sent: 0,
    });
    const res = await dispatchPOST(plainReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ phasesProcessed: 0, created: 0, sent: 0 });
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
