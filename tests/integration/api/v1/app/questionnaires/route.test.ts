/**
 * Integration test: POST /api/v1/app/questionnaires (F1.1 / PR4, T1.4.6).
 *
 * Exercises the route's HTTP orchestration end-to-end with the boundaries mocked:
 * the flag gate, admin auth, multipart guards, SHA-256 dedup, document parse,
 * capability dispatch, persistence, and admin audit. The pure persistence/merge
 * logic is unit-tested separately (persist.test.ts, merge.test.ts); here we prove
 * the wiring, the gate order, the failure-mode envelopes, and that admin-supplied
 * metadata flows to both the extractor (suppression) and the writer (merge).
 *
 * Covers: 404 flag-off · 401 unauth · 403 non-admin · 201 happy · oversize 413 ·
 * unsupported 400 · missing-file 400 · invalid-audience 400 · scanned PDF 422 ·
 * empty 422 · parse-fail 422 · incoherent 422 · dedup 409 · extractor-missing 503 ·
 * dispatch-error status mapping · per-admin rate-limit 429 · audit content.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSourceDocument: { findFirst: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Keep assertPersistable + IncoherentExtractionError real; mock only the writer.
vi.mock('@/app/api/v1/app/questionnaires/_lib/persist', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/persist')>();
  return { ...real, persistIngestion: vi.fn() };
});

// Default-allow limiter; individual tests can flip it to a rejection.
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  INGEST_RATE_LIMIT_MAX: 10,
  INGEST_RATE_LIMIT_INTERVAL_MS: 60_000,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { persistIngestion } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(
  fileName: string | null,
  content = '# Form\n1. Name',
  mimeType = 'text/markdown',
  extraFields: Record<string, string> = {},
  headerOverrides: Record<string, string> = {}
): NextRequest {
  const formData = new FormData();
  if (fileName !== null) {
    formData.set('file', new File([content], fileName, { type: mimeType }));
  }
  for (const [k, v] of Object.entries(extraFields)) formData.set(k, v);

  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'multipart/form-data', ...headerOverrides }),
    url: 'http://localhost:3000/api/v1/app/questionnaires',
    formData: async () => formData,
  } as unknown as NextRequest;
}

/** A coherent extraction (questions map to declared sections). */
const COHERENT_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'About You' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'name',
      prompt: 'What is your name?',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
  ],
  inferredGoal: 'Collect details',
  inferredAudience: { role: 'new hire' },
  changes: [
    { changeType: 'infer_goal', targetEntityType: 'version', afterJson: 'Collect details' },
  ],
};

const PERSIST_RESULT = {
  questionnaireId: 'qn-1',
  versionId: 'ver-1',
  sectionCount: 1,
  questionCount: 1,
  changeCount: 1,
  goal: 'Collect details',
  audience: { role: 'new hire' },
  fieldProvenance: { goal: 'inferred', audience: { role: 'inferred' } },
};

const PARSED_DOC = {
  title: 'Onboarding',
  sections: [{ title: '', content: '# Form', order: 0 }],
  fullText: '# Form\n1. Name',
  metadata: { format: 'markdown' },
  warnings: [],
};

function setAdmin() {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as Mock).mockResolvedValue(true); // flag on by default
  setAdmin();
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue(null); // no dup
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    id: 'agent-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC });
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: structuredClone(COHERENT_EXTRACTION),
  });
  (persistIngestion as Mock).mockResolvedValue(PERSIST_RESULT);
});

// ─── Gate + auth ──────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — gate and auth', () => {
  it('returns 404 NOT_FOUND when the questionnaire app is disabled (gate runs first)', async () => {
    (isFeatureEnabled as Mock).mockResolvedValue(false);

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    // Gate short-circuits before auth or any work.
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(401);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(403);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Happy path ────────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — happy path', () => {
  it('ingests end-to-end and returns 201 with ids, counts, goal/audience, provenance', async () => {
    const res = await POST(makeRequest('onboarding.md'));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 1,
      questionCount: 1,
      changeCount: 1,
      goal: 'Collect details',
      audience: { role: 'new hire' },
      fieldProvenance: { goal: 'inferred', audience: { role: 'inferred' } },
    });

    // Dispatch received the parsed text + file name; persist received the result.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'app_extract_questionnaire_structure',
      expect.objectContaining({ documentText: PARSED_DOC.fullText, fileName: 'onboarding.md' }),
      expect.objectContaining({ userId: ADMIN_ID, agentId: 'agent-1' })
    );
    expect(persistIngestion).toHaveBeenCalledTimes(1);
  });

  it('passes the extractor agent binding through the dispatch context', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'agent-9',
      provider: 'anthropic',
      model: 'claude-x',
      fallbackProviders: ['openai'],
    });

    await POST(makeRequest('form.md'));

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        agentId: 'agent-9',
        entityContext: {
          extractorAgent: {
            provider: 'anthropic',
            model: 'claude-x',
            fallbackProviders: ['openai'],
          },
        },
      })
    );
  });

  it('derives the questionnaire title from the filename when the parsed title is blank', async () => {
    (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC, title: '   ' });

    await POST(makeRequest('Q3 Pulse Survey.md'));

    // Empty parsed title → fall back to the filename without its extension.
    expect(persistIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ documentTitle: 'Q3 Pulse Survey' })
    );
  });

  it('writes an admin audit row with the ingest counts and file hash', async () => {
    await POST(makeRequest('onboarding.md'));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'questionnaire.ingest',
        entityType: 'questionnaire',
        entityId: 'ver-1',
        clientIp: '203.0.113.7',
        metadata: expect.objectContaining({
          questionnaireId: 'qn-1',
          versionId: 'ver-1',
          sectionCount: 1,
          questionCount: 1,
          changeCount: 1,
          fileName: 'onboarding.md',
          fileHash: expect.any(String),
        }),
      })
    );
  });
});

// ─── Admin-supplied metadata wiring ─────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — admin metadata', () => {
  it('forwards admin goal/audience to the extractor (suppression) and the writer (merge)', async () => {
    await POST(
      makeRequest('form.md', '# Form', 'text/markdown', {
        goal: 'Understand attrition',
        'audience.role': 'manager',
        'audience.expertiseLevel': 'expert',
      })
    );

    // The extractor is told which fields not to infer.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adminProvidedGoal: 'Understand attrition',
        adminProvidedAudience: { role: 'manager', expertiseLevel: 'expert' },
      }),
      expect.any(Object)
    );
    // The writer applies the admin-wins merge with the same values.
    expect(persistIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: {
          goal: 'Understand attrition',
          audience: { role: 'manager', expertiseLevel: 'expert' },
        },
      })
    );
  });

  it('returns 400 for invalid audience metadata', async () => {
    const res = await POST(
      makeRequest('form.md', '# Form', 'text/markdown', { 'audience.expertiseLevel': 'wizard' })
    );

    expect(res.status).toBe(400);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Input / upload failure modes ───────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — input failures', () => {
  it('returns 413 FILE_TOO_LARGE on an oversize Content-Length', async () => {
    const res = await POST(
      makeRequest(
        'form.md',
        '# Form',
        'text/markdown',
        {},
        { 'content-length': String(200 * 1024 * 1024) }
      )
    );

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 400 UNSUPPORTED_FORMAT for a disallowed extension', async () => {
    const res = await POST(makeRequest('photo.png', 'binary', 'image/png'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('returns 400 when the file field is missing', async () => {
    const res = await POST(makeRequest(null));

    expect(res.status).toBe(400);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Parse / extraction failure modes ───────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — parse and extraction failures', () => {
  it('returns 422 SCANNED_DOCUMENT for a PDF with no extractable text', async () => {
    (parseDocument as Mock).mockResolvedValue({
      ...PARSED_DOC,
      fullText: '',
      pageInfo: [
        { num: 1, charCount: 0, hasText: false },
        { num: 2, charCount: 0, hasText: false },
      ],
    });

    const res = await POST(makeRequest('scanned.pdf', '%PDF-1.4', 'application/pdf'));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('SCANNED_DOCUMENT');
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 422 EMPTY_DOCUMENT for a non-PDF with no extractable text', async () => {
    (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC, fullText: '   ' });

    const res = await POST(makeRequest('empty.txt', '   ', 'text/plain'));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('EMPTY_DOCUMENT');
  });

  it('returns 422 PARSE_FAILED when the parser throws', async () => {
    (parseDocument as Mock).mockRejectedValue(new Error('corrupt docx'));

    const res = await POST(makeRequest('broken.docx', 'x', 'application/vnd.openxmlformats'));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('PARSE_FAILED');
  });

  it('returns 422 EXTRACTION_INCOHERENT and does not persist when a question orphans its section', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        sections: [{ ordinal: 0, title: 'A' }],
        questions: [
          {
            sectionOrdinal: 9, // no such section
            key: 'q',
            prompt: 'Orphan?',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
        changes: [],
      },
    });

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('EXTRACTION_INCOHERENT');
    expect(body.error.details.orphanSectionOrdinals).toEqual([9]);
    expect(persistIngestion).not.toHaveBeenCalled();
  });

  it.each([
    ['extraction_failed', 502, 'EXTRACTION_FAILED'],
    ['rate_limited', 429, 'EXTRACTOR_RATE_LIMITED'],
    ['no_provider_configured', 503, 'EXTRACTOR_UNAVAILABLE'],
    ['capability_quarantined', 503, 'EXTRACTOR_UNAVAILABLE'],
    ['invalid_args', 400, 'INVALID_EXTRACTION_ARGS'],
  ])('maps dispatch error %s to HTTP %i (%s)', async (capCode, status, topCode) => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: capCode, message: 'boom' },
    });

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(topCode);
    expect(body.error.details.capabilityError).toBe(capCode);
    expect(persistIngestion).not.toHaveBeenCalled();
  });
});

// ─── Dedup / config / rate-limit ────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires — dedup, config, rate-limit', () => {
  it('returns 409 DUPLICATE_DOCUMENT with the existing ids when the same bytes were ingested', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      versionId: 'ver-existing',
      version: { questionnaireId: 'qn-existing' },
    });

    const res = await POST(makeRequest('dup.md'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE_DOCUMENT');
    expect(body.error.details).toEqual({
      questionnaireId: 'qn-existing',
      versionId: 'ver-existing',
    });
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 503 EXTRACTOR_NOT_CONFIGURED when the extractor agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('EXTRACTOR_NOT_CONFIGURED');
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-admin ingest sub-cap is exceeded', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(429);
    // Rate-limited before any parse/dispatch work.
    expect(parseDocument).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
