/**
 * Integration: the round invitations (grant) route — flag gate, 404 on unknown round, and that
 * it delegates to the generator + audits. The generator itself is unit-tested in invites.test.ts.
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
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const genMock = vi.hoisted(() => ({ generateRoundInvitations: vi.fn() }));
vi.mock('@/app/api/v1/app/rounds/_lib/invites', () => genMock);

import { POST } from '@/app/api/v1/app/rounds/[id]/invitations/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const url = 'http://localhost:3000/api/v1/app/rounds/r-1/invitations';
const ctx = { params: Promise.resolve({ id: 'r-1' }) };
function req(): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}
function jsonReq(body: unknown): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({ id: 'r-1', name: 'Round' });
  genMock.generateRoundInvitations.mockResolvedValue({
    created: 2,
    skipped: 0,
    unlaunchedQuestionnaires: 0,
    activeMembers: 2,
    sent: 0,
    links: [],
  });
});

describe('POST /api/v1/app/rounds/:id/invitations', () => {
  it('404s when the cohorts flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(genMock.generateRoundInvitations).not.toHaveBeenCalled();
  });

  it('404s an unknown round', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(genMock.generateRoundInvitations).not.toHaveBeenCalled();
  });

  it('generates invitations and audits it', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(genMock.generateRoundInvitations).toHaveBeenCalledWith('r-1', expect.any(String), {
      send: false,
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_round.generate_invitations' })
    );
  });

  it('passes send:true through when the body opts in', async () => {
    const res = await POST(jsonReq({ send: true }), ctx);
    expect(res.status).toBe(201);
    expect(genMock.generateRoundInvitations).toHaveBeenCalledWith('r-1', expect.any(String), {
      send: true,
    });
  });

  it('falls back to send:false for a malformed body', async () => {
    await POST(jsonReq({ send: 'yes' }), ctx); // wrong type → schema rejects → default false
    expect(genMock.generateRoundInvitations).toHaveBeenCalledWith('r-1', expect.any(String), {
      send: false,
    });
  });
});
