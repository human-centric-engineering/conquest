/**
 * Integration tests: definitions-document routes — definitions / glossary (P16).
 *
 *   POST   …/versions/:vid/glossary/document  (multipart) → parse + attach
 *   DELETE …/versions/:vid/glossary/document               → detach
 *
 * What's worth defending here:
 *   - both handlers FORK a launched version. Unlike the analysis run (whose proposals are inert),
 *     attaching or removing the analyst's source of truth is a durable authoring change;
 *   - an unreadable or text-free document is rejected rather than stored — a scanned PDF would
 *     otherwise persist as an empty "authoritative source" the analyst silently ignores;
 *   - the stored text is capped, because the whole document goes into one prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/glossary-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/glossary-routes')>();
  return { ...real, upsertGlossaryDocument: vi.fn(), deleteGlossaryDocument: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: { check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })) },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  POST,
  DELETE,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/glossary/document/route';
import { auth } from '@/lib/auth/config';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import {
  upsertGlossaryDocument,
  deleteGlossaryDocument,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
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

/** A multipart request carrying `file`. */
function uploadReq(
  name = 'glossary.md',
  contents = '# Glossary\n\nHigher self: the Self that observes.'
): NextRequest {
  const form = new FormData();
  form.append('file', new File([contents], name, { type: 'text/markdown' }));
  return {
    url: 'http://localhost:3000/api/v1',
    headers: new Headers(),
    formData: () => Promise.resolve(form),
  } as unknown as NextRequest;
}

function bareReq(): NextRequest {
  return { url: 'http://localhost:3000/api/v1', headers: new Headers() } as unknown as NextRequest;
}

function scopedVersion(status: 'draft' | 'launched' = 'draft') {
  return { id: 'ver-1', questionnaireId: 'qn-1', versionNumber: 2, status };
}

const noFork = { versionId: 'ver-1', forked: false, versionNumber: 2 };
const forked = { versionId: 'ver-2', forked: true, versionNumber: 3 };

function documentView() {
  return {
    id: 'doc-1',
    fileName: 'glossary.md',
    byteSize: 42,
    mimeType: 'text/markdown',
    textLength: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
  (parseDocument as Mock).mockResolvedValue({
    fullText: 'Higher self: the Self that observes.',
  });
  (upsertGlossaryDocument as Mock).mockResolvedValue(documentView());
  (deleteGlossaryDocument as Mock).mockResolvedValue(undefined);
  (forkVersionIfLaunched as Mock).mockResolvedValue(noFork);
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe('POST …/glossary/document', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(uploadReq(), ctx(PARAMS))).status).toBe(401);
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await POST(uploadReq(), ctx(PARAMS))).status).toBe(403);
  });

  it('returns 404 for a missing version and never parses the upload', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('returns 429 when the upload sub-cap is hit, before touching the version', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 1,
    });
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(loadScopedVersion).not.toHaveBeenCalled();
  });

  it('parses and attaches the document, hashing the bytes', async () => {
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.document.fileName).toBe('glossary.md');
    expect(body.data.truncated).toBe(false);

    const [versionId, document, uploadedBy] = (upsertGlossaryDocument as Mock).mock.calls[0];
    expect(versionId).toBe('ver-1');
    expect(document).toMatchObject({
      fileName: 'glossary.md',
      extractedText: 'Higher self: the Self that observes.',
    });
    // A sha256 hex digest — the dedupe/provenance handle.
    expect(document.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(uploadedBy).toEqual(expect.any(String));
  });

  it('rejects a document no text could be read from, and stores nothing', async () => {
    // The scanned-PDF case: storing this would leave an empty "authoritative source" the analyst
    // silently ignores, which reads to the admin as the feature not working.
    (parseDocument as Mock).mockResolvedValue({ fullText: '   \n  ' });
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(422);
    const body = await res.json();
    // Full envelope, not just the code — a partial check lets `{ success, error }` drift ship.
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('EMPTY_DOCUMENT');
    expect(upsertGlossaryDocument).not.toHaveBeenCalled();
  });

  it('rejects an unreadable document', async () => {
    (parseDocument as Mock).mockRejectedValue(new Error('corrupt'));
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PARSE_FAILED');
    expect(upsertGlossaryDocument).not.toHaveBeenCalled();
  });

  // `.xlsx`, not `.csv`. This route guards on PARSEABLE_UPLOAD_EXTENSIONS and hands the buffer
  // straight to `parseDocument`, which has no workbook branch and THROWS on one — so a workbook is
  // the boundary that still matters here, and the one whose regression would turn a clean 415 into
  // a 500. `.csv` used to sit on the wrong side of this line: the parser router has always had a
  // `.csv` branch, but the upload allowlist never listed it, so the corpus' easiest document could
  // not be ingested at all. Now that it can, asserting a `.csv` rejection would be pinning the bug.
  it('rejects a workbook — this route parses directly and cannot flatten one', async () => {
    const res = await POST(uploadReq('terms.xlsx'), ctx(PARAMS));
    expect(res.status).toBe(415);
    expect(upsertGlossaryDocument).not.toHaveBeenCalled();
  });

  it('rejects a file type no parser handles', async () => {
    const res = await POST(uploadReq('glossary.exe'), ctx(PARAMS));
    expect(res.status).toBe(415);
    expect(upsertGlossaryDocument).not.toHaveBeenCalled();
  });

  it('accepts a .csv glossary — the parser router reads one', async () => {
    const res = await POST(
      uploadReq('terms.csv', 'term,definition\nHigher self,The observer'),
      ctx(PARAMS)
    );
    expect(res.status).toBe(200);
    expect(upsertGlossaryDocument).toHaveBeenCalled();
  });

  it('caps the stored text and reports the truncation', async () => {
    (parseDocument as Mock).mockResolvedValue({ fullText: 'x'.repeat(250_000) });
    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect((await res.json()).data.truncated).toBe(true);

    const [, document] = (upsertGlossaryDocument as Mock).mock.calls[0];
    // The whole document goes into one prompt, so an unbounded upload would fail the run outright.
    expect(document.extractedText).toHaveLength(200_000);
  });

  it('forks a launched version and attaches to the fork', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forked);

    const res = await POST(uploadReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect((await res.json()).meta).toMatchObject({ forked: true, versionId: 'ver-2' });
    expect(upsertGlossaryDocument).toHaveBeenCalledWith(
      'ver-2',
      expect.any(Object),
      expect.any(String)
    );
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE …/glossary/document', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await DELETE(bareReq(), ctx(PARAMS))).status).toBe(401);
  });

  it('returns 404 for a missing version and never deletes', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await DELETE(bareReq(), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(deleteGlossaryDocument).not.toHaveBeenCalled();
  });

  it('detaches the document', async () => {
    const res = await DELETE(bareReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(deleteGlossaryDocument).toHaveBeenCalledWith('ver-1');
  });

  it('forks a launched version and detaches from the fork', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forked);

    const res = await DELETE(bareReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect((await res.json()).meta).toMatchObject({ forked: true, versionId: 'ver-2' });
    expect(deleteGlossaryDocument).toHaveBeenCalledWith('ver-2');
  });
});
