/**
 * Integration test: POST /api/v1/app/questionnaires/:id/duplicate.
 *
 * The general-purpose "make a copy" action — a plain, unattributed duplicate of the
 * current version. Exercises the route's HTTP orchestration with the boundaries
 * mocked: flag gate, admin auth, Zod body, source 404, current-version resolution
 * (launched-else-latest), the transactional create + `copyVersionGraph` call (via the
 * shared `duplicateQuestionnaire` service), and the admin audit. The deep copy itself
 * is single-sourced via `copyVersionGraph` (covered by the fork tests) and stubbed.
 *
 * Covers: 404 flag-off · 401 · 403 · 404 unknown questionnaire · 404 no-version ·
 * 201 happy (default "Copy") · 201 with custom suffix · no demo attribution ·
 * launched-preferred-over-latest · audit content.
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
  },
}));
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/copy-version-graph', () => ({
  // Mirrors the real CopiedGraphMaps shape (all four id maps) so the stub can't
  // drift behind the interface even though the service discards the return value.
  copyVersionGraph: vi.fn(async () => ({
    sectionIdMap: new Map(),
    questionIdMap: new Map(),
    tagIdMap: new Map(),
    dataSlotIdMap: new Map(),
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/duplicate/route';
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
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/duplicate',
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
  txMock.appQuestionnaire.create.mockResolvedValue({ id: 'qn-new' });
  txMock.appQuestionnaireVersion.create.mockResolvedValue({ id: 'ver-new' });
  txMock.appQuestionnaireSourceDocument.findFirst.mockResolvedValue(null);
  txMock.appQuestionnaireSourceDocument.create.mockResolvedValue({ id: 'doc-new' });
});

describe('POST …/duplicate — gate and auth', () => {
  it('404s when the app flag is off, before any work', async () => {
    (isFeatureEnabled as Mock).mockResolvedValue(false);
    const res = await POST(req({}), ctx('qn-1'));
    expect(res.status).toBe(404);
    expect(prisma.appQuestionnaire.findUnique).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req({}), ctx('qn-1'))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await POST(req({}), ctx('qn-1'))).status).toBe(403);
  });
});

describe('POST …/duplicate — resolution', () => {
  it('404s when the source questionnaire is unknown', async () => {
    (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(null);
    const res = await POST(req({}), ctx('qn-x'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('404s when the questionnaire has no version to duplicate', async () => {
    (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);
    const res = await POST(req({}), ctx('qn-1'));
    expect(res.status).toBe(404);
    // Full error envelope — a future refactor returning success:true with an error
    // block would slip past a status-only check.
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toMatch(/no version/i);
  });

  it('prefers the launched version over a later draft', async () => {
    await POST(req({}), ctx('qn-1'));
    expect((prisma.appQuestionnaireVersion.findFirst as Mock).mock.calls[0][0]).toMatchObject({
      where: { questionnaireId: 'qn-1', status: 'launched' },
    });
    expect(copyVersionGraph).toHaveBeenCalledWith(expect.anything(), 'ver-launched', 'ver-new');
  });

  it('falls back to the highest-numbered version when none is launched', async () => {
    // No launched version → the service's `launched ?? latest` fallback fires and the
    // second findFirst (no status filter) resolves the draft that gets copied.
    const DRAFT = { ...VERSION, id: 'ver-draft' };
    (prisma.appQuestionnaireVersion.findFirst as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(DRAFT);

    const res = await POST(req({}), ctx('qn-1'));

    expect(res.status).toBe(201);
    // The launched probe carried the status filter; the fallback probe did not.
    const calls = (prisma.appQuestionnaireVersion.findFirst as Mock).mock.calls;
    expect(calls[0][0]).toMatchObject({ where: { questionnaireId: 'qn-1', status: 'launched' } });
    expect(calls[1][0].where).toEqual({ questionnaireId: 'qn-1' });
    expect(copyVersionGraph).toHaveBeenCalledWith(expect.anything(), 'ver-draft', 'ver-new');
  });
});

describe('POST …/duplicate — happy path', () => {
  it('duplicates into a new unattributed draft titled "… — Copy", copies the graph, and audits', async () => {
    const res = await POST(req({}), ctx('qn-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { questionnaireId: 'qn-new', versionId: 'ver-new' },
    });

    // New draft, default "Copy" suffix, NO demo attribution.
    const data = txMock.appQuestionnaire.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ title: 'Customer NPS — Copy', status: 'draft' });
    expect(data).not.toHaveProperty('demoClientId');

    // Fresh v1, all of goal/audience/provenance copied from the source version
    // (asserting every copied field so none can silently stop carrying over).
    expect(txMock.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionnaireId: 'qn-new',
          versionNumber: 1,
          status: 'draft',
          goal: 'Understand satisfaction',
          audience: VERSION.audience,
          goalProvenance: 'inferred',
          audienceProvenance: VERSION.audienceProvenance,
        }),
      })
    );
    expect(copyVersionGraph).toHaveBeenCalledWith(expect.anything(), 'ver-launched', 'ver-new');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire.duplicate',
        entityId: 'qn-new',
        metadata: expect.objectContaining({
          sourceQuestionnaireId: 'qn-1',
          sourceVersionId: 'ver-launched',
          newVersionId: 'ver-new',
        }),
      })
    );
  });

  it('uses a custom name suffix when supplied', async () => {
    await POST(req({ nameSuffix: 'Pilot' }), ctx('qn-1'));
    expect(txMock.appQuestionnaire.create.mock.calls[0][0].data.title).toBe('Customer NPS — Pilot');
  });

  it('copies the source-document provenance row when one exists', async () => {
    // Best-effort provenance carry: a present source doc is re-created against the new
    // version (raw bytes were never persisted, so only the parsed metadata/text copies).
    txMock.appQuestionnaireSourceDocument.findFirst.mockResolvedValue({
      fileName: 'survey.pdf',
      fileHash: 'sha256:abc',
      byteSize: 2048,
      mimeType: 'application/pdf',
      pageCount: 3,
      warnings: ['truncated'],
      extractedText: 'Q1. ...',
    });

    const res = await POST(req({}), ctx('qn-1'));

    expect(res.status).toBe(201);
    expect(txMock.appQuestionnaireSourceDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionId: 'ver-new',
          fileName: 'survey.pdf',
          fileHash: 'sha256:abc',
          pageCount: 3,
        }),
      })
    );
  });

  it('skips source-document provenance when the source has none', async () => {
    // Default beforeEach already returns null; assert the create is genuinely skipped.
    await POST(req({}), ctx('qn-1'));
    expect(txMock.appQuestionnaireSourceDocument.create).not.toHaveBeenCalled();
  });
});
