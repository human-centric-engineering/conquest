/**
 * Integration test for `PATCH /api/v1/app/questionnaires/:id` — the two
 * questionnaire-level mutations the route discriminates by body:
 *   • rename (`{ title }`)              — see the rename describe block.
 *   • demo-client attribution (F2.5.1)  — set/clear `demoClientId`.
 * Covers the gate order, auth, the unknown-questionnaire 404, the unknown-demo-client
 * 404 on attach, the detach (null) path, the rename no-op, and audit emission. The
 * questionnaire read GET lives in read-routes.test.ts; this only exercises PATCH.
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
  appQuestionnaire: { findUnique: vi.fn(), update: vi.fn() },
  appDemoClient: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// getQuestionnaireDetail is mocked only so importing the route (whose GET handler
// uses it) doesn't pull the real read model — the PATCH handler returns a minimal
// { id, demoClient } and does not call it.
vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getQuestionnaireDetail: vi.fn(),
  getVersionGraph: vi.fn(),
}));

import { PATCH as attributePATCH } from '@/app/api/v1/app/questionnaires/[id]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getQuestionnaireDetail } from '@/app/api/v1/app/questionnaires/_lib/detail';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function jsonReq(body: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
});

describe('PATCH /api/v1/app/questionnaires/:id (attribution)', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await attributePATCH(jsonReq({ demoClientId: 'dc-1' }), ctx('qn-1'));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await attributePATCH(jsonReq({ demoClientId: 'dc-1' }), ctx('qn-1'))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await attributePATCH(jsonReq({ demoClientId: 'dc-1' }), ctx('qn-1'))).status).toBe(403);
  });

  it('404s when the questionnaire is unknown', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);
    const res = await attributePATCH(jsonReq({ demoClientId: 'dc-1' }), ctx('missing'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('404s when attaching an unknown demo client', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      demoClientId: null,
    });
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    const res = await attributePATCH(jsonReq({ demoClientId: 'ghost' }), ctx('qn-1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('DEMO_CLIENT_NOT_FOUND');
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('attaches a valid demo client and audits', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      demoClientId: null,
    });
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      slug: 'acme-bank',
      name: 'Acme Bank',
    });
    prismaMock.appQuestionnaire.update.mockResolvedValue({ id: 'qn-1' });

    const res = await attributePATCH(jsonReq({ demoClientId: 'dc-1' }), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      id: 'qn-1',
      demoClient: { id: 'dc-1', slug: 'acme-bank', name: 'Acme Bank' },
    });
    expect(prismaMock.appQuestionnaire.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'qn-1' }, data: { demoClientId: 'dc-1' } })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire.assign_demo_client' })
    );
    // Slim response — the heavy detail read model is not recomputed here.
    expect(getQuestionnaireDetail).not.toHaveBeenCalled();
  });

  it('detaches with null without checking a client', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      demoClientId: 'dc-1',
    });
    prismaMock.appQuestionnaire.update.mockResolvedValue({ id: 'qn-1' });

    const res = await attributePATCH(jsonReq({ demoClientId: null }), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1', demoClient: null });
    expect(prismaMock.appDemoClient.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaire.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { demoClientId: null } })
    );
  });
});

describe('PATCH /api/v1/app/questionnaires/:id (rename)', () => {
  it('404s when the questionnaire is unknown', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);
    const res = await attributePATCH(jsonReq({ title: 'New name' }), ctx('missing'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('rejects an empty title without writing or auditing', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      demoClientId: null,
    });
    const res = await attributePATCH(jsonReq({ title: '   ' }), ctx('qn-1'));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('renames the questionnaire, trims, and audits the change', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Chris Thomas Questionnaire.xlsx',
      demoClientId: null,
    });
    prismaMock.appQuestionnaire.update.mockResolvedValue({ id: 'qn-1' });

    const res = await attributePATCH(jsonReq({ title: '  Merlin5 Questionnaire  ' }), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1', title: 'Merlin5 Questionnaire' });
    expect(prismaMock.appQuestionnaire.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'qn-1' }, data: { title: 'Merlin5 Questionnaire' } })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire.rename',
        entityId: 'qn-1',
        entityName: 'Merlin5 Questionnaire',
      })
    );
    // Demo-client path is untouched by a rename.
    expect(prismaMock.appDemoClient.findUnique).not.toHaveBeenCalled();
  });

  it('treats an unchanged title as a no-op: no write, no audit, still 200', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      demoClientId: null,
    });

    const res = await attributePATCH(jsonReq({ title: 'Onboarding' }), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1', title: 'Onboarding' });
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
