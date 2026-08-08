/**
 * Integration tests: publish-glossary-to-client-KB route — definitions / glossary (P16).
 *
 * POST …/versions/:vid/glossary/publish
 *
 * This is the one write in the feature that ESCAPES the version boundary — the knowledge base is
 * scoped per demo client while a glossary is per version — so the guards are the point of this
 * file:
 *
 *   - an unattributed questionnaire is refused outright rather than silently no-op'ing;
 *   - an empty glossary is refused, so no placeholder document lands in a client corpus;
 *   - the rendered document leads with a SCOPE LINE and carries the questionnaire + version in its
 *     name, which is the only thing that lets a reader tell two clients' glossaries apart;
 *   - the client tag is applied idempotently, so re-publishing identical content (which
 *     `uploadDocument` dedupes to the existing row) doesn't fail on the composite primary key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  aiKnowledgeDocumentTag: { upsert: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({ uploadDocument: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => ({
  ensureClientKnowledgeTag: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/glossary/resolve', () => ({
  loadAcceptedGlossaryEntries: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/glossary-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/glossary-routes')>();
  // Keep `renderGlossaryKnowledgeDocument` REAL — the scope line it emits is asserted below.
  return { ...real, loadGlossaryPublishTarget: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: { check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })) },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/glossary/publish/route';
import { auth } from '@/lib/auth/config';
import { uploadDocument } from '@/lib/orchestration/knowledge/document-manager';
import { ensureClientKnowledgeTag } from '@/lib/app/questionnaire/report/client-knowledge';
import { loadAcceptedGlossaryEntries } from '@/lib/app/questionnaire/glossary/resolve';
import { loadGlossaryPublishTarget } from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
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

function req(): NextRequest {
  return { url: 'http://localhost:3000/api/v1', headers: new Headers() } as unknown as NextRequest;
}

function target(over: Record<string, unknown> = {}) {
  return {
    questionnaireTitle: 'Inner Work',
    versionNumber: 3,
    demoClientId: 'client-1',
    demoClientName: 'Acme Retreats',
    acceptedTermCount: 2,
    ...over,
  };
}

const ENTRIES = [
  {
    termId: 't-hs',
    term: 'higher self',
    surfaces: ['higher self'],
    definitions: ['The observing, values-led part of you.'],
  },
  {
    termId: 't-ego',
    term: 'ego',
    surfaces: ['ego'],
    definitions: ['The constructed self.', 'The Jungian conscious centre.'],
  },
];

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` wipes the factory's default implementation, so re-prime the limiter every
  // test rather than relying on module state surviving (brittle-pattern #11).
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  setAuth(mockAdminUser());
  (loadScopedVersion as Mock).mockResolvedValue({
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 3,
    status: 'launched',
  });
  (loadGlossaryPublishTarget as Mock).mockResolvedValue(target());
  (loadAcceptedGlossaryEntries as Mock).mockResolvedValue(ENTRIES);
  (ensureClientKnowledgeTag as Mock).mockResolvedValue('tag-1');
  (uploadDocument as Mock).mockResolvedValue({ id: 'doc-1' });
  prismaMock.aiKnowledgeDocumentTag.upsert.mockResolvedValue({});
});

// ─── Gates ────────────────────────────────────────────────────────────────────

describe('POST …/glossary/publish — gates', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(), ctx(PARAMS))).status).toBe(401);
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await POST(req(), ctx(PARAMS))).status).toBe(403);
  });

  it('returns 404 for a missing version and publishes nothing', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    expect((await POST(req(), ctx(PARAMS))).status).toBe(404);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('returns 429 when the upload sub-cap is hit, before any paid work', async () => {
    // A publish chunks and embeds a document — the same paid class as an ingest, which is why it
    // shares `ingestLimiter`. The cap must bite before the version is even loaded.
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 1,
    });

    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(loadScopedVersion).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses an unattributed questionnaire rather than silently doing nothing', async () => {
    // The KB is scoped per client; with no client there is nowhere to publish. A clear 409 beats a
    // no-op the admin would read as success.
    (loadGlossaryPublishTarget as Mock).mockResolvedValue(
      target({ demoClientId: null, demoClientName: null })
    );
    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(409);
    const body = await res.json();
    // Full envelope, not just the code — a partial check lets `{ success, error }` drift ship.
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NO_CLIENT_ATTRIBUTED');
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses an empty glossary, so no placeholder lands in a client corpus', async () => {
    (loadAcceptedGlossaryEntries as Mock).mockResolvedValue([]);
    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('EMPTY_GLOSSARY');
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses when the client knowledge tag cannot be resolved', async () => {
    (ensureClientKnowledgeTag as Mock).mockResolvedValue(null);
    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(409);
    expect(uploadDocument).not.toHaveBeenCalled();
  });
});

// ─── The publish ──────────────────────────────────────────────────────────────

describe('POST …/glossary/publish — the publish', () => {
  it('uploads a deterministically-named document and tags it to the client', async () => {
    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toMatchObject({
      documentId: 'doc-1',
      documentName: 'Glossary — Inner Work (v3)',
      termCount: 2,
      clientName: 'Acme Retreats',
    });

    const [content, fileName, userId, sourceUrl, displayName] = (uploadDocument as Mock).mock
      .calls[0];
    // Name carries the questionnaire + version, so two glossaries in one corpus are at least
    // visibly distinct in the KB panel rather than silently indistinguishable.
    expect(displayName).toBe('Glossary — Inner Work (v3)');
    expect(fileName).toBe('Glossary — Inner Work (v3).md');
    expect(userId).toEqual(expect.any(String));
    // Traceable back to the exact version — the only provenance a KB reader gets.
    expect(sourceUrl).toBe('/admin/questionnaires/qn-1/v/ver-1/definitions');
    expect(typeof content).toBe('string');

    expect(prismaMock.aiKnowledgeDocumentTag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId_tagId: { documentId: 'doc-1', tagId: 'tag-1' } },
        update: {},
      })
    );
  });

  it('leads the document with a scope line naming the questionnaire and version', async () => {
    await POST(req(), ctx(PARAMS));
    const [content] = (uploadDocument as Mock).mock.calls[0] as [string];

    // Retrieval cannot tell two clients' glossaries apart; this line is the only disambiguator a
    // reader (or a report writer that retrieved it) gets.
    expect(content).toContain('# Glossary — Inner Work (v3)');
    expect(content).toContain('These definitions apply to the questionnaire "Inner Work"');
    expect(content).toContain('may not hold for other questionnaires');
  });

  it('renders several senses as a numbered list rather than merging them', async () => {
    await POST(req(), ctx(PARAMS));
    const [content] = (uploadDocument as Mock).mock.calls[0] as [string];

    expect(content).toContain('## higher self');
    expect(content).toContain('The observing, values-led part of you.');
    expect(content).toContain('more than one sense');
    expect(content).toContain('1. The constructed self.');
    expect(content).toContain('2. The Jungian conscious centre.');
  });

  it('does NOT fork the version — the write escapes the version boundary by design', async () => {
    // Publishing is not an authoring edit to this version; it copies OUT of it. Forking here would
    // strand the published document against a draft nobody is running.
    //
    // Asserted against the fork writer itself, NOT against an absent `meta.forked`: the route
    // never passes `meta` to successResponse, so `meta?.forked` is undefined by construction and
    // would read as "no fork" even if the route started forking. The version is deliberately
    // `launched` here — the state that WOULD fork on any authoring route.
    (loadScopedVersion as Mock).mockResolvedValue({
      id: 'ver-1',
      questionnaireId: 'qn-1',
      versionNumber: 3,
      status: 'launched',
    });

    const res = await POST(req(), ctx(PARAMS));
    expect(res.status).toBe(200);

    // Falsifiable: the audit entry and the KB write both name the LAUNCHED version. If the route
    // ever forked, these would carry the new draft's id instead.
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'ver-1',
        metadata: expect.objectContaining({ versionId: 'ver-1' }),
      })
    );
  });

  it('writes an audit entry naming the client and the document', async () => {
    await POST(req(), ctx(PARAMS));
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_glossary.publish_to_client_kb',
        entityId: 'ver-1',
        metadata: expect.objectContaining({ demoClientId: 'client-1', documentId: 'doc-1' }),
      })
    );
  });
});
