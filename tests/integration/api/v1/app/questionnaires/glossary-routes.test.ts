/**
 * Integration tests: glossary collection routes — definitions / glossary feature (P16).
 *
 *   GET /api/v1/app/questionnaires/:id/versions/:vid/glossary  → curated terms + document
 *   PUT /api/v1/app/questionnaires/:id/versions/:vid/glossary  → replace-set (fork if launched)
 *
 * Gate order for both handlers: non-admin → 403; unauthenticated → 401; missing/cross-id
 * version → 404.
 *
 * The two behaviours worth defending here beyond the gates:
 *   - the replace-set's schema invariants (duplicate surfaces, accepted-with-nothing-selected)
 *     reject BEFORE the fork, so a bad payload never leaves a stray draft behind;
 *   - saving off a launched version forks AND retires the proposals stranded on the source, so
 *     the analyst's suggestions don't orphan on a version nobody will look at again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Mock the DB-touching seam helpers; keep the schema + validator real.
vi.mock('@/app/api/v1/app/questionnaires/_lib/glossary-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/glossary-routes')>();
  return {
    ...real,
    loadGlossaryTerms: vi.fn(),
    loadGlossaryDocument: vi.fn(),
    replaceGlossaryTerms: vi.fn(),
    deleteProposedGlossaryTerms: vi.fn(),
  };
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

import { GET, PUT } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/glossary/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  loadGlossaryTerms,
  loadGlossaryDocument,
  replaceGlossaryTerms,
  deleteProposedGlossaryTerms,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
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

/** One persisted term view as the route returns it. */
function sampleTerms() {
  return [
    {
      id: 'term-1',
      term: 'higher self',
      normalizedTerm: 'higher self',
      aliases: ['higher-self'],
      status: 'accepted',
      source: 'ai_proposed',
      rationale: 'Used without definition and contested across traditions.',
      contextQuote: 'How connected do you feel to your higher self?',
      ordinal: 0,
      definitions: [
        {
          id: 'def-1',
          text: 'The observing, values-led part of you.',
          selected: true,
          source: 'ai_proposed',
          sourceQuote: null,
          edited: false,
          ordinal: 0,
        },
      ],
    },
  ];
}

function sampleDocument() {
  return {
    id: 'doc-1',
    fileName: 'glossary.pdf',
    byteSize: 2048,
    mimeType: 'application/pdf',
    textLength: 4096,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A minimal valid replace-set body: one accepted term with one selected definition. */
function validBody() {
  return {
    terms: [
      {
        term: 'higher self',
        aliases: ['higher-self'],
        status: 'accepted',
        source: 'admin',
        definitions: [{ text: 'The observing, values-led part of you.', selected: true }],
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
  (loadGlossaryTerms as Mock).mockResolvedValue(sampleTerms());
  (loadGlossaryDocument as Mock).mockResolvedValue(sampleDocument());
  (replaceGlossaryTerms as Mock).mockResolvedValue(sampleTerms());
  (deleteProposedGlossaryTerms as Mock).mockResolvedValue(undefined);
  (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/app/questionnaires/:id/versions/:vid/glossary', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the version is missing or belongs to another questionnaire', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(loadGlossaryTerms).not.toHaveBeenCalled();
  });

  it('returns the curated terms and the attached definitions document', async () => {
    const res = await GET(getReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.terms).toHaveLength(1);
    expect(body.data.terms[0].term).toBe('higher self');
    expect(body.data.document.fileName).toBe('glossary.pdf');
    expect(loadGlossaryTerms).toHaveBeenCalledWith('ver-1');
  });

  it('returns a null document when the version has none', async () => {
    (loadGlossaryDocument as Mock).mockResolvedValue(null);
    const res = await GET(getReq(), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.document).toBeNull();
  });
});

// ─── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/app/questionnaires/:id/versions/:vid/glossary', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(403);
  });

  it('returns 404 for a missing version and never forks', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(replaceGlossaryTerms).not.toHaveBeenCalled();
  });

  it('saves the reviewed set and reports the accepted count', async () => {
    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.terms).toHaveLength(1);
    expect(replaceGlossaryTerms).toHaveBeenCalledWith(
      'ver-1',
      expect.arrayContaining([expect.objectContaining({ term: 'higher self' })]),
      expect.any(String)
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_glossary.save',
        metadata: expect.objectContaining({ termCount: 1, acceptedCount: 1 }),
      })
    );
  });

  it('accepts an empty set — clearing the glossary is a legitimate save', async () => {
    (replaceGlossaryTerms as Mock).mockResolvedValue([]);
    const res = await PUT(jsonReq({ terms: [] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(replaceGlossaryTerms).toHaveBeenCalledWith('ver-1', [], expect.any(String));
  });

  it('rejects duplicate surfaces before writing anything', async () => {
    const body = {
      terms: [
        {
          term: 'higher-self',
          status: 'accepted',
          definitions: [{ text: 'One.', selected: true }],
        },
        {
          term: 'Higher Self',
          status: 'accepted',
          definitions: [{ text: 'Two.', selected: true }],
        },
      ],
    };
    const res = await PUT(jsonReq(body), ctx(PARAMS));
    expect(res.status).toBe(400);
    // The fork is the expensive, visible side effect — it must not happen on a bad payload.
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(replaceGlossaryTerms).not.toHaveBeenCalled();
  });

  it('rejects an accepted term with no definition selected', async () => {
    const body = {
      terms: [
        {
          term: 'ego',
          status: 'accepted',
          definitions: [{ text: 'Nobody ticked this.', selected: false }],
        },
      ],
    };
    const res = await PUT(jsonReq(body), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(replaceGlossaryTerms).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const res = await PUT(jsonReq({ terms: 'not-an-array' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(replaceGlossaryTerms).not.toHaveBeenCalled();
  });

  it('forks a launched version, writes to the fork, and retires the source proposals', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());

    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.meta).toMatchObject({ forked: true, versionId: 'ver-2', versionNumber: 3 });

    // The write lands on the FORK, not the launched version the URL named.
    expect(replaceGlossaryTerms).toHaveBeenCalledWith(
      'ver-2',
      expect.any(Array),
      expect.any(String)
    );
    // Proposals stranded on the source are retired so they don't orphan.
    expect(deleteProposedGlossaryTerms).toHaveBeenCalledWith('ver-1');
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'ver-2' }));
  });

  it('does not touch proposals on a no-fork save — they are on the version being edited', async () => {
    const res = await PUT(jsonReq(validBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(deleteProposedGlossaryTerms).not.toHaveBeenCalled();
  });
});
