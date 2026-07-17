/**
 * Integration test for the questionnaire soft-delete pair:
 *   • DELETE /api/v1/app/questionnaires/:id          — archive (stamp `archivedAt`).
 *   • POST   /api/v1/app/questionnaires/:id/restore  — restore (clear `archivedAt`).
 *
 * Covers auth (401/403), the unknown-questionnaire 404, the happy-path stamp/clear
 * with audit emission, and — importantly — idempotency: archiving an already-archived
 * (or restoring an already-active) questionnaire is a no-op 200 that neither writes
 * nor re-audits. That idempotency is the contract the UI leans on when a stale row is
 * acted on twice.
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
  appQuestionnaire: { findUnique: vi.fn(), update: vi.fn() },
  appDemoClient: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// The [id] route module also exports GET (detail) — mock the read model so importing
// it doesn't drag in the real Prisma-backed detail query.
vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getQuestionnaireDetail: vi.fn(),
  getVersionGraph: vi.fn(),
}));

import { DELETE as archiveDELETE } from '@/app/api/v1/app/questionnaires/[id]/route';
import { POST as restorePOST } from '@/app/api/v1/app/questionnaires/[id]/restore/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1',
    headers: new Headers(),
  } as unknown as NextRequest;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const ARCHIVED_AT = new Date('2026-07-17T13:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
});

describe('DELETE /api/v1/app/questionnaires/:id (archive)', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await archiveDELETE(req(), ctx('qn-1'))).status).toBe(401);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await archiveDELETE(req(), ctx('qn-1'))).status).toBe(403);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('404s when the questionnaire is unknown', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);
    const res = await archiveDELETE(req(), ctx('missing'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('stamps archivedAt and audits questionnaire.archive', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      archivedAt: null,
    });
    prismaMock.appQuestionnaire.update.mockResolvedValue({ archivedAt: ARCHIVED_AT });

    const res = await archiveDELETE(req(), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1', archivedAt: ARCHIVED_AT.toISOString() });
    // The write sets a Date (not null) on archivedAt.
    expect(prismaMock.appQuestionnaire.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'qn-1' },
        data: { archivedAt: expect.any(Date) },
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire.archive',
        entityId: 'qn-1',
        entityName: 'Onboarding',
      })
    );
  });

  it('is idempotent: an already-archived questionnaire 200s without a write or audit', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      archivedAt: ARCHIVED_AT,
    });

    const res = await archiveDELETE(req(), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Echoes the existing timestamp — the row is untouched.
    expect(body.data).toEqual({ id: 'qn-1', archivedAt: ARCHIVED_AT.toISOString() });
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/app/questionnaires/:id/restore', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await restorePOST(req(), ctx('qn-1'))).status).toBe(401);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await restorePOST(req(), ctx('qn-1'))).status).toBe(403);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('404s when the questionnaire is unknown', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);
    const res = await restorePOST(req(), ctx('missing'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
  });

  it('clears archivedAt and audits questionnaire.restore', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      archivedAt: ARCHIVED_AT,
    });
    prismaMock.appQuestionnaire.update.mockResolvedValue({ id: 'qn-1' });

    const res = await restorePOST(req(), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1' });
    expect(prismaMock.appQuestionnaire.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'qn-1' }, data: { archivedAt: null } })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire.restore',
        entityId: 'qn-1',
        entityName: 'Onboarding',
      })
    );
  });

  it('is idempotent: an already-active questionnaire 200s without a write or audit', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue({
      id: 'qn-1',
      title: 'Onboarding',
      archivedAt: null,
    });

    const res = await restorePOST(req(), ctx('qn-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'qn-1' });
    expect(prismaMock.appQuestionnaire.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
