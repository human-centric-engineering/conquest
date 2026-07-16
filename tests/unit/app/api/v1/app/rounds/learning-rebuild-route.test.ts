/**
 * Unit: the Learning Mode digest-rebuild route (phase 5).
 *
 * Collaborators mocked at the module boundary. Asserts it rebuilds each bundled version and reports a
 * per-version summary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireRound: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/app/questionnaire/learning/digest', () => ({
  refreshRoundLearningDigest: vi.fn(),
}));
vi.mock('@/app/api/v1/app/rounds/_lib/context', () => ({
  listBriefableQuestionnaires: vi.fn(),
}));

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;
const { POST } = (await import('@/app/api/v1/app/rounds/[id]/learning/rebuild/route')) as {
  POST: AnyRouteHandler;
};

import { prisma } from '@/lib/db/client';
import { refreshRoundLearningDigest } from '@/lib/app/questionnaire/learning/digest';
import { listBriefableQuestionnaires } from '@/app/api/v1/app/rounds/_lib/context';
import { mockAdminUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
// Full better-auth session shape (withAdminAuth is identity-mocked here, so we pass it directly).
const ADMIN = mockAdminUser();
const ctx = { params: Promise.resolve({ id: 'r-1' }) };
const req = () =>
  new NextRequest('http://localhost/api/v1/app/rounds/r-1/learning/rebuild', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({ id: 'r-1', name: 'July' });
  (listBriefableQuestionnaires as Mock).mockResolvedValue([
    { versionId: 'v-1', title: 'A', questionnaireId: 'q1', questions: [] },
    { versionId: 'v-2', title: 'B', questionnaireId: 'q2', questions: [] },
  ]);
  (refreshRoundLearningDigest as Mock).mockResolvedValue({ built: true, slotCount: 2 });
});

describe('POST …/learning/rebuild', () => {
  it('rebuilds each bundled version and returns a per-version summary', async () => {
    const res = await POST(req(), ADMIN, ctx);
    expect(res.status).toBe(200);
    expect(refreshRoundLearningDigest).toHaveBeenCalledTimes(2);
    expect(refreshRoundLearningDigest).toHaveBeenCalledWith('r-1', 'v-1');
    expect(refreshRoundLearningDigest).toHaveBeenCalledWith('r-1', 'v-2');
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.versions).toHaveLength(2);
    // The per-version summary carries the builder's full result (incl. slotCount), not just built.
    expect(body.data.versions[0]).toMatchObject({ versionId: 'v-1', built: true, slotCount: 2 });
  });

  it('throws NotFoundError for an unknown round (real withAdminAuth converts this to a 404)', async () => {
    // withAdminAuth is identity-mocked here, so the NotFoundError surfaces as a throw rather than the
    // 404 envelope the real guard produces via handleAPIError. We assert the round guard fires before
    // any rebuild work; the guard's error→404 conversion is covered by withAdminAuth's own tests.
    (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue(null);
    await expect(POST(req(), ADMIN, ctx)).rejects.toThrow('Round not found');
    expect(refreshRoundLearningDigest).not.toHaveBeenCalled();
  });

  it('dedupes a version bundled twice (one rebuild per distinct version)', async () => {
    (listBriefableQuestionnaires as Mock).mockResolvedValue([
      { versionId: 'v-1', title: 'A', questionnaireId: 'q1', questions: [] },
      { versionId: 'v-1', title: 'A', questionnaireId: 'q2', questions: [] },
    ]);
    await POST(req(), ADMIN, ctx);
    expect(refreshRoundLearningDigest).toHaveBeenCalledTimes(1);
  });
});
