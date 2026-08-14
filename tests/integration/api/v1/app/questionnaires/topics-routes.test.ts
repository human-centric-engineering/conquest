/**
 * Integration tests: topics collection routes — Adaptive Scope (P17).
 *
 *   GET   /api/v1/app/questionnaires/:id/versions/:vid/topics  → topics + settings + inventory
 *   PUT   /api/v1/app/questionnaires/:id/versions/:vid/topics  → replace-set (fork if launched)
 *   PATCH /api/v1/app/questionnaires/:id/versions/:vid/topics  → patch `adaptiveScope` settings
 *
 * Gate order for all three handlers: non-admin → 403; unauthenticated → 401; missing/cross-id
 * version → 404.
 *
 * The behaviour worth defending here beyond the gates: PUT and PATCH both call
 * `forkVersionIfLaunched` before writing. A LAUNCHED version forks — the write must land on the
 * fork's id, not the vid the URL named, and `meta.forked` must say so. A DRAFT version must NOT
 * fork — the write lands directly on the vid in the URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
    appScoringSchema: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Mock the DB-touching seam helpers; keep the schema + validator real.
vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-routes')>();
  return {
    ...real,
    loadAdaptiveScopeSettings: vi.fn(),
    loadTopics: vi.fn(),
    replaceTopics: vi.fn(),
    patchAdaptiveScopeSettings: vi.fn(),
  };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-draft', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-draft')>();
  return { ...real, loadTopicDraft: vi.fn() };
});

// Mock the authoring-routes scope loader; keep forkMeta real (pure function).
vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({
  forkVersionIfLaunched: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET, PUT, PATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  loadAdaptiveScopeSettings,
  loadTopics,
  replaceTopics,
  patchAdaptiveScopeSettings,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { loadTopicDraft } from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { DEFAULT_ADAPTIVE_SCOPE_SETTINGS } from '@/lib/app/questionnaire/scope/types';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const PARAMS = { id: 'qn-1', vid: 'ver-1' };

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function jsonReq(body: unknown, url = 'http://localhost:3000/api/v1'): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function getReq(url = 'http://localhost:3000/api/v1'): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function scopedVersion(status: 'draft' | 'launched' | 'archived' = 'draft') {
  return { id: 'ver-1', questionnaireId: 'qn-1', versionNumber: 2, status };
}

function noForkResult() {
  return { versionId: 'ver-1', forked: false, versionNumber: 2 };
}

function forkResult() {
  return { versionId: 'ver-2', forked: true, versionNumber: 3 };
}

/** One persisted topic as the route reads it back. */
function sampleTopic(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'topic-1',
    key: 'wellbeing',
    label: 'Wellbeing',
    description: null,
    phase: 'conditional',
    criteria: 'Respondent mentions stress',
    depth: 'full',
    members: { questionKeys: ['q1'], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
    ...overrides,
  };
}

/** A minimal valid replace-set body: one conditional topic with criteria and one member. */
function validSaveBody() {
  return {
    topics: [
      {
        key: 'wellbeing',
        label: 'Wellbeing',
        phase: 'conditional',
        criteria: 'Respondent mentions stress',
        questionKeys: ['q1'],
        dataSlotKeys: [],
      },
    ],
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();

  setAuth(mockAdminUser());
  (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
  (loadAdaptiveScopeSettings as Mock).mockResolvedValue(DEFAULT_ADAPTIVE_SCOPE_SETTINGS);
  (loadTopics as Mock).mockResolvedValue([sampleTopic()]);
  (loadTopicDraft as Mock).mockResolvedValue(null);
  (replaceTopics as Mock).mockResolvedValue([sampleTopic()]);
  (patchAdaptiveScopeSettings as Mock).mockResolvedValue({
    ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
    enabled: true,
  });
  (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
  (prisma.appQuestionSlot.findMany as Mock).mockResolvedValue([]);
  (prisma.appDataSlot.findMany as Mock).mockResolvedValue([]);
  // Most versions do not score — the comparability checks (F17.15) then have nothing to say.
  (prisma.appScoringSchema.findUnique as Mock).mockResolvedValue(null);
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/app/questionnaires/:id/versions/:vid/topics', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 404 with the full error envelope when the version is missing or cross-id', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(loadTopics).not.toHaveBeenCalled();
  });

  it('returns the topics, settings, inventory and draft', async () => {
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.topics).toHaveLength(1);
    expect(body.data.topics[0].key).toBe('wellbeing');
    expect(body.data.settings).toMatchObject({ enabled: false });
    expect(body.data.draft).toBeNull();
    expect(loadTopics).toHaveBeenCalledWith('ver-1');
  });

  it('surfaces the pending draft when one exists', async () => {
    const draft = {
      v: 1,
      topics: [],
      rules: [],
      summary: 'Nothing routable found.',
      fromDocument: false,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    (loadTopicDraft as Mock).mockResolvedValue(draft);
    const res = await GET(getReq(), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.draft).toEqual(draft);
  });

  it('reports a scale that routing can leave partially assessed (F17.15)', async () => {
    // `wellbeing` is the version's only topic and it is conditional, so a respondent not routed to
    // it is scored on none of the scale — and the cohort report will exclude them.
    (loadAdaptiveScopeSettings as Mock).mockResolvedValue({
      ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
      enabled: true,
    });
    (prisma.appScoringSchema.findUnique as Mock).mockResolvedValue({
      content: {
        scales: [{ key: 'strain', name: 'Strain' }],
        items: [{ source: 'question', ref: 'q1', scaleKey: 'strain', weight: 1, reverse: false }],
        bands: [],
        method: 'mean',
      },
    });

    const res = await GET(getReq(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(200);
    const scaleIssues = body.data.issues.filter((i: { code: string }) =>
      i.code.startsWith('scale_')
    );
    expect(scaleIssues).toHaveLength(1);
    expect(scaleIssues[0].code).toBe('scale_split_by_scope');
    expect(scaleIssues[0].message).toContain('Strain');
  });

  it('says nothing about scales when the version has no scoring schema', async () => {
    const res = await GET(getReq(), ctx(PARAMS));
    const body = await res.json();
    expect(
      body.data.issues.filter((i: { code: string }) => i.code.startsWith('scale_'))
    ).toHaveLength(0);
  });
});

// ─── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/app/questionnaires/:id/versions/:vid/topics', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PUT(jsonReq(validSaveBody()), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await PUT(jsonReq(validSaveBody()), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 404 for a missing version and never forks or writes', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await PUT(jsonReq(validSaveBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(replaceTopics).not.toHaveBeenCalled();
  });

  it('rejects a malformed body before forking or writing', async () => {
    const res = await PUT(jsonReq({ topics: 'not-an-array' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(replaceTopics).not.toHaveBeenCalled();
  });

  it('saves the reviewed set on a draft version WITHOUT forking', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
    (replaceTopics as Mock).mockResolvedValue([sampleTopic({ key: 'wellbeing' })]);

    const res = await PUT(jsonReq(validSaveBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.meta).toMatchObject({ forked: false, versionId: 'ver-1', versionNumber: 2 });

    // The write lands on the URL's own vid — no fork happened.
    expect(replaceTopics).toHaveBeenCalledWith(
      'ver-1',
      expect.arrayContaining([expect.objectContaining({ key: 'wellbeing' })])
    );
    expect(body.data.topics[0].key).toBe('wellbeing');
  });

  it('forks a LAUNCHED version and writes to the fork — the handler-derived id, not the URL vid', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());
    (replaceTopics as Mock).mockResolvedValue([sampleTopic({ id: 'topic-2', key: 'wellbeing' })]);

    const res = await PUT(jsonReq(validSaveBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Handler-derived fields: the fork's id/versionNumber, not anything the request dictated.
    expect(body.meta).toMatchObject({ forked: true, versionId: 'ver-2', versionNumber: 3 });
    expect(replaceTopics).toHaveBeenCalledWith(
      'ver-2',
      expect.arrayContaining([expect.objectContaining({ key: 'wellbeing' })])
    );
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'ver-2' }));
  });
});

// ─── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/app/questionnaires/:id/versions/:vid/topics', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PATCH(jsonReq({ enabled: true }), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await PATCH(jsonReq({ enabled: true }), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 404 for a missing version and never forks or writes', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await PATCH(jsonReq({ enabled: true }), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(patchAdaptiveScopeSettings).not.toHaveBeenCalled();
  });

  it('patches settings on a draft version WITHOUT forking', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
    (patchAdaptiveScopeSettings as Mock).mockResolvedValue({
      ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
      enabled: true,
    });

    const res = await PATCH(jsonReq({ enabled: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.meta).toMatchObject({ forked: false, versionId: 'ver-1', versionNumber: 2 });

    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith('ver-1', { enabled: true });
    expect(body.data.settings.enabled).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_adaptive_scope.update',
        entityId: 'ver-1',
        metadata: expect.objectContaining({ enabled: true }),
      })
    );
  });

  it('forks a LAUNCHED version and writes settings to the fork — the handler-derived id', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());
    (patchAdaptiveScopeSettings as Mock).mockResolvedValue({
      ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
      enabled: true,
    });

    const res = await PATCH(jsonReq({ enabled: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.meta).toMatchObject({ forked: true, versionId: 'ver-2', versionNumber: 3 });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith('ver-2', { enabled: true });
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'ver-2' }));
  });
});
