/**
 * Integration tests: the source-document routes (F17.29).
 *
 *   GET    /api/v1/app/questionnaires/:id/versions/:vid/documents           → the version's documents
 *   POST   /api/v1/app/questionnaires/:id/versions/:vid/documents           → attach a supporting one
 *   DELETE /api/v1/app/questionnaires/:id/versions/:vid/documents/:docId    → detach a supporting one
 *
 * Gate order for all three: non-admin → 403; unauthenticated → 401; missing/cross-id version → 404.
 *
 * The behaviour worth defending beyond the gates:
 *  - a document is only ever written with role `supplementary` — the instrument's provenance row
 *    belongs to ingest, which extracts a structure from it in the same pass;
 *  - the count cap and the same-file check are enforced BEFORE the upload is parsed, which is the
 *    one expensive step here;
 *  - DELETE refuses a `primary` row, and on a fork deletes the COPY rather than the row the URL
 *    named — the original stays with the launched version, which is the point of forking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSourceDocument: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: { check: vi.fn(() => ({ success: true })) },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/extract-pipeline', () => ({
  parseAndGuardUpload: vi.fn(),
  parseUploadToText: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({
  forkVersionIfLaunched: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/documents/route';
import { DELETE } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/documents/[docId]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  parseAndGuardUpload,
  parseUploadToText,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { MAX_SUPPLEMENTARY_DOCUMENTS } from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const PARAMS = { id: 'qn-1', vid: 'ver-1' };
const DOC_PARAMS = { ...PARAMS, docId: 'doc-9' };

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function req(url = 'http://localhost:3000/api/v1'): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function scopedVersion(status: 'draft' | 'launched' = 'draft') {
  return { id: 'ver-1', questionnaireId: 'qn-1', versionNumber: 2, status };
}

function upload(name = 'routing-memo.md', hash = 'hash-new') {
  return {
    ok: true,
    value: {
      file: { name, size: 2048, type: 'text/markdown' },
      buffer: Buffer.from('x'),
      fileHash: hash,
      adminMeta: {},
      extractTables: false,
      requiredMode: 'all',
    },
  };
}

function parsed(fullText = 'Only ask Section 6 of franchise owners.') {
  return { ok: true, value: { fullText, warnings: [], pageInfo: null } };
}

function documentRows() {
  return [
    {
      id: 'doc-1',
      role: 'primary',
      fileName: 'bank.md',
      byteSize: 1000,
      mimeType: 'text/markdown',
      pageCount: null,
      extractedText: 'Q1. How many partners?',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  (loadScopedVersion as Mock).mockResolvedValue(scopedVersion());
  (forkVersionIfLaunched as Mock).mockResolvedValue({
    versionId: 'ver-1',
    forked: false,
    versionNumber: 2,
  });
  (prisma.appQuestionnaireSourceDocument.findMany as Mock).mockResolvedValue(documentRows());
  (prisma.appQuestionnaireSourceDocument.count as Mock).mockResolvedValue(0);
  (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue(null);
  (prisma.appQuestionnaireSourceDocument.create as Mock).mockResolvedValue({ id: 'doc-new' });
  (prisma.appQuestionnaireSourceDocument.deleteMany as Mock).mockResolvedValue({ count: 1 });
  // Re-stated here, not left to the module factory: `clearAllMocks` wipes call history but keeps
  // a `mockReturnValue` an earlier test set, so the 429 case would otherwise leak into every test
  // that runs after it.
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: 0,
  });
  (parseAndGuardUpload as Mock).mockResolvedValue(upload());
  (parseUploadToText as Mock).mockResolvedValue(parsed());
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe('GET /documents', () => {
  it('returns each document with its role and the size of its text, never the text', async () => {
    // The extracted text is the instrument and runs to megabytes. A list of filenames must not
    // pay for it.
    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.documents).toEqual([
      {
        id: 'doc-1',
        role: 'primary',
        fileName: 'bank.md',
        byteSize: 1000,
        mimeType: 'text/markdown',
        pageCount: null,
        characterCount: 'Q1. How many partners?'.length,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('How many partners');
  });

  it('404s a version outside the questionnaire in the URL', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(404);
  });

  it('403s a non-admin and 401s an anonymous caller', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await GET(req(), ctx(PARAMS))).status).toBe(403);
    setAuth(mockUnauthenticatedUser());
    expect((await GET(req(), ctx(PARAMS))).status).toBe(401);
  });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe('POST /documents', () => {
  it('stores the parsed upload as a supplementary document and audits it', async () => {
    const res = await POST(req(), ctx(PARAMS));

    expect(res.status).toBe(201);
    const created = (prisma.appQuestionnaireSourceDocument.create as Mock).mock.calls[0][0];
    expect(created.data).toMatchObject({
      versionId: 'ver-1',
      role: 'supplementary',
      fileName: 'routing-memo.md',
      fileHash: 'hash-new',
      extractedText: 'Only ask Section 6 of franchise owners.',
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_source_document.attach' })
    );
  });

  it('never writes a primary row — that provenance belongs to ingest', async () => {
    // A primary row written here would claim the version's questions came from a document they
    // did not come from.
    await POST(req(), ctx(PARAMS));
    const created = (prisma.appQuestionnaireSourceDocument.create as Mock).mock.calls[0][0];
    expect(created.data.role).toBe('supplementary');
  });

  it('rejects a file already on the version, before parsing it', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      id: 'doc-1',
      fileName: 'routing-memo.md',
      role: 'supplementary',
    });

    const res = await POST(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('DUPLICATE_DOCUMENT');
    // Parsing a 25MB PDF only to reject it for being the file already attached is the waste.
    expect(parseUploadToText).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSourceDocument.create).not.toHaveBeenCalled();
  });

  it('says plainly when the duplicate is the instrument itself', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      id: 'doc-1',
      fileName: 'bank.md',
      role: 'primary',
    });

    const res = await POST(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('DUPLICATE_DOCUMENT');
    expect(body.error.message).toContain('built from');
  });

  it('refuses more than the cap, before parsing', async () => {
    (prisma.appQuestionnaireSourceDocument.count as Mock).mockResolvedValue(
      MAX_SUPPLEMENTARY_DOCUMENTS
    );

    const res = await POST(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('TOO_MANY_DOCUMENTS');
    expect(parseUploadToText).not.toHaveBeenCalled();
  });

  it('429s over the ingest sub-cap, before reading or parsing anything', async () => {
    // The per-admin sub-cap is checked FIRST, ahead of the version load: an attach parses an
    // upload, so it is budgeted with ingest and re-ingest rather than the 100/min section default.
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await POST(req(), ctx(PARAMS));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    // Nothing downstream ran — not the parse, not the count, not the write.
    expect(parseAndGuardUpload).not.toHaveBeenCalled();
    expect(parseUploadToText).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSourceDocument.count).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSourceDocument.create).not.toHaveBeenCalled();
  });

  it('passes a parse failure straight through, with the upload dialog’s own code', async () => {
    (parseUploadToText as Mock).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 422 }),
    });

    const res = await POST(req(), ctx(PARAMS));

    expect(res.status).toBe(422);
    expect(prisma.appQuestionnaireSourceDocument.create).not.toHaveBeenCalled();
  });

  it('writes to the fork, not the launched version the URL named', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue({
      versionId: 'ver-2',
      forked: true,
      versionNumber: 3,
    });

    const res = await POST(req(), ctx(PARAMS));
    const body = await res.json();

    const created = (prisma.appQuestionnaireSourceDocument.create as Mock).mock.calls[0][0];
    expect(created.data.versionId).toBe('ver-2');
    expect(body.meta.forked).toBe(true);
    expect(body.meta.versionId).toBe('ver-2');
  });

  it('403s a non-admin and 401s an anonymous caller', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await POST(req(), ctx(PARAMS))).status).toBe(403);
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(), ctx(PARAMS))).status).toBe(401);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /documents/:docId', () => {
  beforeEach(() => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      id: 'doc-9',
      role: 'supplementary',
      fileName: 'routing-memo.md',
      fileHash: 'hash-memo',
    });
  });

  it('detaches a supporting document and audits it', async () => {
    const res = await DELETE(req(), ctx(DOC_PARAMS));

    expect(res.status).toBe(200);
    const call = (prisma.appQuestionnaireSourceDocument.deleteMany as Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: 'doc-9', versionId: 'ver-1', role: 'supplementary' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_source_document.detach' })
    );
  });

  it('refuses to delete the instrument’s provenance row', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      id: 'doc-1',
      role: 'primary',
      fileName: 'bank.md',
      fileHash: 'hash-bank',
    });

    const res = await DELETE(req(), ctx({ ...PARAMS, docId: 'doc-1' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('PRIMARY_DOCUMENT');
    expect(prisma.appQuestionnaireSourceDocument.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the COPY on a fork, matched by hash, never the launched version’s row', async () => {
    // Ids are regenerated by the copy, so matching on the id in the URL would delete nothing —
    // or, worse, reach back into the version the admin was just moved off.
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue({
      versionId: 'ver-2',
      forked: true,
      versionNumber: 3,
    });

    await DELETE(req(), ctx(DOC_PARAMS));

    const call = (prisma.appQuestionnaireSourceDocument.deleteMany as Mock).mock.calls[0][0];
    expect(call.where).toEqual({
      versionId: 'ver-2',
      fileHash: 'hash-memo',
      role: 'supplementary',
    });
  });

  it('404s a document id that belongs to another version', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue(null);
    const res = await DELETE(req(), ctx(DOC_PARAMS));
    expect(res.status).toBe(404);
  });

  it('403s a non-admin and 401s an anonymous caller', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await DELETE(req(), ctx(DOC_PARAMS))).status).toBe(403);
    setAuth(mockUnauthenticatedUser());
    expect((await DELETE(req(), ctx(DOC_PARAMS))).status).toBe(401);
  });
});
