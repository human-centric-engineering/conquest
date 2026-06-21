/**
 * Unit: the Learning Mode digest-rebuild route (phase 5).
 *
 * Collaborators mocked at the module boundary. Asserts it rebuilds each bundled version and reports a
 * per-version summary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  withLearningModeEnabled: (handler: unknown) => handler,
}));
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

type Mock = ReturnType<typeof vi.fn>;
const ADMIN = { user: { id: 'admin-1' } };
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
    expect(body.data.versions).toHaveLength(2);
    expect(body.data.versions[0]).toMatchObject({ versionId: 'v-1', built: true });
  });

  it('raises a not-found error for an unknown round (→ 404 via the admin-auth wrapper)', async () => {
    // withAdminAuth is mocked as identity here, so the NotFoundError it would normally convert to a
    // 404 envelope surfaces as a throw — we assert the round guard fires before any rebuild work.
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
