/**
 * Integration test for the per-version soft-archive pair:
 *   • POST /api/v1/app/questionnaires/:id/versions/:vid/archive  — stamp `archivedAt`.
 *   • POST /api/v1/app/questionnaires/:id/versions/:vid/restore  — clear `archivedAt`.
 *
 * Covers auth (401/403), the unknown / cross-questionnaire version 404 (via the scope-load),
 * the happy-path stamp/clear with audit emission, and idempotency (already-archived archive /
 * already-active restore is a no-op 200 that neither writes nor re-audits). Prisma + auth are
 * mocked so the handlers run without a database — same discipline as the questionnaire-level
 * archive-route test.
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
  appQuestionnaireVersion: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { POST as archivePOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/archive/route';
import { POST as restorePOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/restore/route';
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
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/archive',
    headers: new Headers(),
  } as unknown as NextRequest;
}

function ctx(id: string, vid: string): { params: Promise<{ id: string; vid: string }> } {
  return { params: Promise.resolve({ id, vid }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

/** The scope-load (`loadScopedVersion`) resolves the version within its questionnaire. */
function scopeResolves() {
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    status: 'launched',
  });
}

const ARCHIVED_AT = new Date('2026-07-17T13:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
});

describe('POST …/versions/:vid/archive', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await archivePOST(req(), ctx('qn-1', 'v1'))).status).toBe(401);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await archivePOST(req(), ctx('qn-1', 'v1'))).status).toBe(403);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve within the questionnaire (scoping)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await archivePOST(req(), ctx('qn-1', 'nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('stamps archivedAt and audits questionnaire_version.archive', async () => {
    scopeResolves();
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: null,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ archivedAt: ARCHIVED_AT });

    const res = await archivePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 'v1', archivedAt: ARCHIVED_AT.toISOString() });
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: { archivedAt: expect.any(Date) } })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.archive', entityId: 'v1' })
    );
  });

  it('404s if the version vanishes between the scope-load and the write (concurrent delete)', async () => {
    scopeResolves(); // loadScopedVersion (findFirst) sees it…
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(null); // …but setVersionArchived doesn't.
    const res = await archivePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-archived version 200s without a write or audit', async () => {
    scopeResolves();
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: ARCHIVED_AT,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });

    const res = await archivePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 'v1', archivedAt: ARCHIVED_AT.toISOString() });
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe('POST …/versions/:vid/restore', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await restorePOST(req(), ctx('qn-1', 'v1'))).status).toBe(401);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await restorePOST(req(), ctx('qn-1', 'v1'))).status).toBe(403);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve within the questionnaire (scoping)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await restorePOST(req(), ctx('qn-1', 'nope'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('clears archivedAt and audits questionnaire_version.restore', async () => {
    scopeResolves();
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: ARCHIVED_AT,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ archivedAt: null });

    const res = await restorePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 'v1', archivedAt: null });
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: { archivedAt: null } })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.restore', entityId: 'v1' })
    );
  });

  it('404s if the version vanishes between the scope-load and the write (concurrent delete)', async () => {
    scopeResolves();
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(null);
    const res = await restorePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-active version 200s without a write or audit', async () => {
    scopeResolves();
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      archivedAt: null,
      questionnaireId: 'qn-1',
      versionNumber: 2,
    });

    const res = await restorePOST(req(), ctx('qn-1', 'v1'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 'v1', archivedAt: null });
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
