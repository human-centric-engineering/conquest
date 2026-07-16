/**
 * Integration test: bulk requiredness route (PATCH …/versions/:vid/questions).
 *
 * Exercises the HTTP orchestration with the DB seam (`prisma`) and the fork writer
 * mocked: gate order (flag-off 404 before auth), auth matrix, scope-404, the
 * happy-path bulk `updateMany`, the fork preamble retargeting the write to the new
 * draft, body validation, and audit emission. The fork deep-copy itself is
 * unit-tested in fork.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

// Mock the fork writer — its deep copy is unit-tested separately. Default: no fork.
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionSlot: { updateMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { PATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/questions/route';

import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(body?: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/questions',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) };

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

function noFork(versionId = 'v1', versionNumber = 1) {
  return { versionId, forked: false, versionNumber };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue(noFork());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  prismaMock.appQuestionSlot.updateMany.mockResolvedValue({ count: 5 });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await PATCH(req({ required: true }), ctx)).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await PATCH(req({ required: true }), ctx)).status).toBe(403);
  });
});

describe('scope 404', () => {
  it('404s when the id/vid pair does not resolve, before any write', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await PATCH(req({ required: true }), ctx);
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionSlot.updateMany).not.toHaveBeenCalled();
  });
});

describe('bulk requiredness PATCH', () => {
  it('sets every question required on a draft and returns the count', async () => {
    const res = await PATCH(req({ required: true }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.updateMany).toHaveBeenCalledWith({
      where: { versionId: 'v1' },
      data: { required: true },
    });
    expect(json.data).toEqual({ updated: 5, required: true });
    expect(json.meta).toMatchObject({ forked: false, versionId: 'v1' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_question.bulk_required',
        entityId: 'v1',
        metadata: expect.objectContaining({ required: true, updated: 5 }),
      })
    );
  });

  it('sets every question optional when required is false', async () => {
    await PATCH(req({ required: false }), ctx);
    expect(prismaMock.appQuestionSlot.updateMany).toHaveBeenCalledWith({
      where: { versionId: 'v1' },
      data: { required: false },
    });
  });

  it('writes to the forked draft and surfaces meta.forked when the version is launched', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });

    const res = await PATCH(req({ required: true }), ctx);
    const json = await res.json();

    // The bulk write targets the new draft, not the launched original.
    expect(prismaMock.appQuestionSlot.updateMany).toHaveBeenCalledWith({
      where: { versionId: 'v2' },
      data: { required: true },
    });
    expect(json.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
  });

  it('400s when the body omits the required boolean', async () => {
    const res = await PATCH(req({}), ctx);
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.updateMany).not.toHaveBeenCalled();
  });

  it('400s when required is not a boolean', async () => {
    const res = await PATCH(req({ required: 'yes' }), ctx);
    expect(res.status).toBe(400);
  });
});
