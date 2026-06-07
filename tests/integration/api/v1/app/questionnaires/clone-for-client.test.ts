/**
 * Integration test: POST /api/v1/app/questionnaires/:id/clone-for-client (DEMO-ONLY,
 * deferred-gaps Item 4).
 *
 * Exercises the route's HTTP orchestration with the boundaries mocked: flag gate,
 * admin auth, Zod body, source 404, current-version resolution (launched-else-latest),
 * target-client 404, the transactional create + `copyVersionGraph` call, source-doc
 * copy, and the admin audit. The deep copy itself is single-sourced via
 * `copyVersionGraph` (covered by the fork tests) and stubbed here.
 *
 * Covers: 404 flag-off · 401 · 403 · 400 bad body · 404 unknown questionnaire · 404
 * no-version · 404 unknown target client · 201 happy (attributed) · 201 generic (None)
 * · launched-preferred-over-latest · audit content.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const txMock = vi.hoisted(() => ({
  appQuestionnaire: { create: vi.fn() },
  appQuestionnaireVersion: { create: vi.fn() },
  appQuestionnaireSourceDocument: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findFirst: vi.fn() },
    appDemoClient: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/copy-version-graph', () => ({
  copyVersionGraph: vi.fn(async () => ({
    sectionIdMap: new Map(),
    questionIdMap: new Map(),
    tagIdMap: new Map(),
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/clone-for-client/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { copyVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/copy-version-graph';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(body: unknown): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/clone-for-client',
    json: async () => body,
  } as unknown as NextRequest;
}

const VERSION = {
  id: 'ver-launched',
  goal: 'Understand satisfaction',
  audience: { role: 'customer' },
  goalProvenance: 'inferred',
  audienceProvenance: { role: 'inferred' },
};

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue({
    id: 'qn-1',
    title: 'Customer NPS',
  });
  // Default: a launched version exists.
  (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(VERSION);
  (prisma.appDemoClient.findUnique as Mock).mockResolvedValue({ name: 'Acme Bank' });
  txMock.appQuestionnaire.create.mockResolvedValue({ id: 'qn-new' });
  txMock.appQuestionnaireVersion.create.mockResolvedValue({ id: 'ver-new' });
  txMock.appQuestionnaireSourceDocument.findFirst.mockResolvedValue(null);
  txMock.appQuestionnaireSourceDocument.create.mockResolvedValue({ id: 'doc-new' });
});

describe('POST …/clone-for-client — gate and auth', () => {
  it('404s when the app flag is off, before any work', async () => {
    (isFeatureEnabled as Mock).mockResolvedValue(false);
    const res = await POST(req({ targetDemoClientId: null }), ctx('qn-1'));
    expect(res.status).toBe(404);
    expect(prisma.appQuestionnaire.findUnique).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req({ targetDemoClientId: null }), ctx('qn-1'))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await POST(req({ targetDemoClientId: null }), ctx('qn-1'))).status).toBe(403);
  });

  it('400s on a malformed body (missing targetDemoClientId)', async () => {
    expect((await POST(req({}), ctx('qn-1'))).status).toBe(400);
  });
});

describe('POST …/clone-for-client — resolution', () => {
  it('404s when the source questionnaire is unknown', async () => {
    (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(null);
    const res = await POST(req({ targetDemoClientId: null }), ctx('qn-x'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('404s when the questionnaire has no version to clone', async () => {
    (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);
    const res = await POST(req({ targetDemoClientId: null }), ctx('qn-1'));
    expect(res.status).toBe(404);
  });

  it('404s when the target demo client does not exist', async () => {
    (prisma.appDemoClient.findUnique as Mock).mockResolvedValue(null);
    const res = await POST(req({ targetDemoClientId: 'dc-missing' }), ctx('qn-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('DEMO_CLIENT_NOT_FOUND');
  });

  it('prefers the launched version over a later draft', async () => {
    await POST(req({ targetDemoClientId: null }), ctx('qn-1'));
    // The first version lookup filters on status: 'launched'.
    expect((prisma.appQuestionnaireVersion.findFirst as Mock).mock.calls[0][0]).toMatchObject({
      where: { questionnaireId: 'qn-1', status: 'launched' },
    });
    expect(copyVersionGraph).toHaveBeenCalledWith(expect.anything(), 'ver-launched', 'ver-new');
  });
});

describe('POST …/clone-for-client — happy path', () => {
  it('clones into a new attributed draft, copies the graph, and audits', async () => {
    const res = await POST(req({ targetDemoClientId: 'dc-1', nameSuffix: 'Pilot' }), ctx('qn-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { questionnaireId: 'qn-new', versionId: 'ver-new' },
    });

    // New questionnaire created as a draft attributed to the target client, title
    // suffixed (explicit suffix wins over the client name).
    expect(txMock.appQuestionnaire.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Customer NPS — Pilot',
          status: 'draft',
          demoClientId: 'dc-1',
        }),
      })
    );
    // Fresh v1, goal/audience copied from the source version.
    expect(txMock.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionnaireId: 'qn-new',
          versionNumber: 1,
          status: 'draft',
          goal: 'Understand satisfaction',
        }),
      })
    );
    expect(copyVersionGraph).toHaveBeenCalledWith(expect.anything(), 'ver-launched', 'ver-new');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire.clone_for_client',
        entityId: 'qn-new',
        metadata: expect.objectContaining({
          sourceQuestionnaireId: 'qn-1',
          targetDemoClientId: 'dc-1',
        }),
      })
    );
  });

  it('clones generically (None) without attribution and defaults the title to "Copy"', async () => {
    const res = await POST(req({ targetDemoClientId: null }), ctx('qn-1'));
    expect(res.status).toBe(201);
    // No client lookup when unattributed.
    expect(prisma.appDemoClient.findUnique).not.toHaveBeenCalled();
    const data = txMock.appQuestionnaire.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('demoClientId');
    expect(data.title).toBe('Customer NPS — Copy');
  });

  it('copies the source document provenance when one exists', async () => {
    txMock.appQuestionnaireSourceDocument.findFirst.mockResolvedValue({
      fileName: 'survey.pdf',
      fileHash: 'abc',
      byteSize: 1234,
      mimeType: 'application/pdf',
      pageCount: 3,
      warnings: ['note'],
      extractedText: 'Q1...',
    });
    await POST(req({ targetDemoClientId: null }), ctx('qn-1'));
    expect(txMock.appQuestionnaireSourceDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ versionId: 'ver-new', fileName: 'survey.pdf' }),
      })
    );
  });
});
