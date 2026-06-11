/**
 * Integration test: POST /api/v1/app/questionnaires/:id/versions/:vid/reingest (F2.4).
 *
 * Exercises the re-ingest route's HTTP orchestration with the boundaries mocked:
 * flag gate, admin auth, per-admin sub-cap, scope-404, the draft-only 409, the
 * shared upload→extract pipeline (parse, dispatch, coherence), the version-scoped
 * SHA-256 dedup short-circuit, the replace-in-place writer, and the admin audit.
 * The pure writer (`reingestVersion`) is unit-/integration-tested via the writer
 * itself; here we prove the wiring, the gate order, and the F2.4-specific seams.
 *
 * Covers: 404 flag-off · 401 · 403 · 404 unknown/cross-id version · 409 non-draft
 * (launched + archived) · 200 happy (replace) · 200 dedup short-circuit (no
 * writes, no dispatch) · 413/400/400 input · 422 scanned/empty/parse/incoherent ·
 * dispatch-error mapping · 503 extractor-missing · 429 sub-cap · audit content.
 */

import { createHash } from 'node:crypto';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: { findFirst: vi.fn() },
    appQuestionnaireSourceDocument: { findFirst: vi.fn() },
    appQuestionnaireSection: { count: vi.fn() },
    appQuestionSlot: { count: vi.fn() },
    appQuestionnaireExtractionChange: { count: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Mock only the writer; keep the REAL ReingestNotDraftError so the route's
// `instanceof` wiring is exercised against the real class, not a hand-rolled
// stand-in (a renamed/moved real class would then fail the TOCTOU test).
vi.mock('@/app/api/v1/app/questionnaires/_lib/reingest', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/reingest')>();
  return { ...real, reingestVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  INGEST_RATE_LIMIT_MAX: 10,
  INGEST_RATE_LIMIT_INTERVAL_MS: 60_000,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/reingest/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  reingestVersion,
  ReingestNotDraftError,
} from '@/app/api/v1/app/questionnaires/_lib/reingest';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const PARAMS = { id: 'qn-1', vid: 'ver-1' };

function ctx(params: { id: string; vid: string }): {
  params: Promise<{ id: string; vid: string }>;
} {
  return { params: Promise.resolve(params) };
}

/** The route hashes the raw upload bytes; mirror that to drive the dedup branch. */
function hashOf(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

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
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/ver-1/reingest',
    formData: async () => formData,
  } as unknown as NextRequest;
}

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

const REINGEST_RESULT = {
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

function setVersion(status: 'draft' | 'launched' | 'archived') {
  (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    status,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  setVersion('draft');
  (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue(null); // no dedup
  (prisma.appQuestionnaireSection.count as Mock).mockResolvedValue(1);
  (prisma.appQuestionSlot.count as Mock).mockResolvedValue(1);
  (prisma.appQuestionnaireExtractionChange.count as Mock).mockResolvedValue(1);
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
  (reingestVersion as Mock).mockResolvedValue(REINGEST_RESULT);
});

// ─── Gate + auth ──────────────────────────────────────────────────────────────

describe('POST …/reingest — gate and auth', () => {
  it('returns 404 when the app is disabled (gate runs before auth and any work)', async () => {
    (isFeatureEnabled as Mock).mockResolvedValue(false);

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(reingestVersion).not.toHaveBeenCalled();
  });
});

// ─── Scope + draft-only ─────────────────────────────────────────────────────────

describe('POST …/reingest — scope and draft-only', () => {
  it('returns 404 when the version does not resolve under the questionnaire', async () => {
    (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it.each(['launched', 'archived'] as const)(
    'returns 409 REINGEST_NOT_DRAFT for a %s version (no parse, no dispatch, no write)',
    async (status) => {
      setVersion(status);

      const res = await POST(makeRequest('form.md'), ctx(PARAMS));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('REINGEST_NOT_DRAFT');
      expect(parseDocument).not.toHaveBeenCalled();
      expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
      expect(reingestVersion).not.toHaveBeenCalled();
    }
  );

  it('maps a ReingestNotDraftError from the writer (TOCTOU: launched mid-flight) to 409', async () => {
    // Outer check passes (draft), but the version is launched by the time the
    // writer's transaction re-asserts status — it throws, the route returns 409.
    (reingestVersion as Mock).mockRejectedValue(new ReingestNotDraftError('launched'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('REINGEST_NOT_DRAFT');
  });

  it('propagates a non-ReingestNotDraftError from the writer as 500 (not swallowed)', async () => {
    // The catch only special-cases ReingestNotDraftError; any other failure must
    // bubble to the framework error handler, not be masked as a 409 or success.
    (reingestVersion as Mock).mockRejectedValue(new Error('db exploded'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });
});

// ─── Happy path (replace in place) ──────────────────────────────────────────────

describe('POST …/reingest — happy path', () => {
  it('replaces the draft graph and returns 200 with counts, goal/audience, deduped:false', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));

    expect(res.status).toBe(200);
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
      deduped: false,
    });

    // The writer targets this version and receives the parsed source provenance.
    expect(reingestVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'ver-1',
        extraction: expect.objectContaining({ inferredGoal: 'Collect details' }),
        source: expect.objectContaining({
          fileName: 'onboarding.md',
          extractedText: PARSED_DOC.fullText,
        }),
      })
    );
  });

  it('forwards admin goal/audience to the extractor and the writer', async () => {
    await POST(
      makeRequest('form.md', '# Form', 'text/markdown', {
        goal: 'Refresh structure',
        'audience.role': 'manager',
      }),
      ctx(PARAMS)
    );

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adminProvidedGoal: 'Refresh structure',
        adminProvidedAudience: { role: 'manager' },
      }),
      expect.any(Object)
    );
    expect(reingestVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: { goal: 'Refresh structure', audience: { role: 'manager' } },
      })
    );
  });

  it('writes an admin audit row keyed to the version with the re-ingest counts', async () => {
    await POST(makeRequest('onboarding.md'), ctx(PARAMS));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'questionnaire.reingest',
        entityType: 'questionnaire_version',
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

// ─── Dedup short-circuit ────────────────────────────────────────────────────────

describe('POST …/reingest — version-scoped dedup short-circuit', () => {
  const SAME = 'identical document bytes';

  it('returns 200 deduped:true with unchanged applied counts and performs no extraction or write', async () => {
    // The active (most recent) source doc has the same hash as the upload.
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      fileHash: hashOf(SAME),
    });
    (prisma.appQuestionnaireSection.count as Mock).mockResolvedValue(3);
    (prisma.appQuestionSlot.count as Mock).mockResolvedValue(7);
    (prisma.appQuestionnaireExtractionChange.count as Mock).mockResolvedValue(2);

    const res = await POST(makeRequest('same.md', SAME), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 3,
      questionCount: 7,
      changeCount: 2,
      deduped: true,
    });
    // No re-extraction, no write, no audit.
    expect(parseDocument).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(reingestVersion).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
    // changeCount is applied-only, matching the detail/list read models.
    expect(prisma.appQuestionnaireExtractionChange.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'ver-1', status: 'applied' } })
    );
  });

  it('matches the active source doc only — a superseded document re-extracts', async () => {
    // The active source doc has a DIFFERENT hash (a newer doc replaced the upload's).
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      fileHash: hashOf('a different, newer document'),
    });

    const res = await POST(makeRequest('superseded.md', SAME), ctx(PARAMS));

    expect(res.status).toBe(200);
    expect((await res.json()).data.deduped).toBe(false);
    // Re-extracts and replaces — does not falsely report "nothing changed".
    expect(capabilityDispatcher.dispatch).toHaveBeenCalled();
    expect(reingestVersion).toHaveBeenCalled();
  });

  it('does not short-circuit when an admin goal override is supplied (it must not be dropped)', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      fileHash: hashOf(SAME),
    });

    const res = await POST(
      makeRequest('same.md', SAME, 'text/markdown', { goal: 'New goal' }),
      ctx(PARAMS)
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.deduped).toBe(false);
    // The override forces the full re-extract + merge path even for identical bytes.
    expect(reingestVersion).toHaveBeenCalledWith(
      expect.objectContaining({ admin: { goal: 'New goal' } })
    );
  });

  it('scopes the dedup query to the target version, newest source doc first', async () => {
    await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(prisma.appQuestionnaireSourceDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId: 'ver-1' },
        orderBy: { createdAt: 'desc' },
      })
    );
  });
});

// ─── Input / upload failure modes ───────────────────────────────────────────────

describe('POST …/reingest — input failures', () => {
  it('returns 413 FILE_TOO_LARGE on an oversize Content-Length', async () => {
    const res = await POST(
      makeRequest(
        'form.md',
        '# Form',
        'text/markdown',
        {},
        {
          'content-length': String(200 * 1024 * 1024),
        }
      ),
      ctx(PARAMS)
    );

    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 400 UNSUPPORTED_FORMAT for a disallowed extension', async () => {
    const res = await POST(makeRequest('photo.png', 'binary', 'image/png'), ctx(PARAMS));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('returns 400 when the file field is missing', async () => {
    const res = await POST(makeRequest(null), ctx(PARAMS));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid audience metadata', async () => {
    const res = await POST(
      makeRequest('form.md', '# Form', 'text/markdown', { 'audience.expertiseLevel': 'wizard' }),
      ctx(PARAMS)
    );

    expect(res.status).toBe(400);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Parse / extraction failure modes ───────────────────────────────────────────

describe('POST …/reingest — parse and extraction failures', () => {
  it('returns 422 SCANNED_DOCUMENT for a PDF with no extractable text', async () => {
    (parseDocument as Mock).mockResolvedValue({
      ...PARSED_DOC,
      fullText: '',
      pageInfo: [{ num: 1, charCount: 0, hasText: false }],
    });

    const res = await POST(makeRequest('scanned.pdf', '%PDF-1.4', 'application/pdf'), ctx(PARAMS));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('SCANNED_DOCUMENT');
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 422 EMPTY_DOCUMENT for a non-PDF with no extractable text', async () => {
    (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC, fullText: '   ' });

    const res = await POST(makeRequest('empty.txt', '   ', 'text/plain'), ctx(PARAMS));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('EMPTY_DOCUMENT');
  });

  it('returns 422 PARSE_FAILED when the parser throws', async () => {
    (parseDocument as Mock).mockRejectedValue(new Error('corrupt docx'));

    const res = await POST(makeRequest('broken.docx', 'x', 'application/vnd'), ctx(PARAMS));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('PARSE_FAILED');
  });

  it('returns 422 EXTRACTION_INCOHERENT and does not write when a question orphans its section', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        sections: [{ ordinal: 0, title: 'A' }],
        questions: [
          {
            sectionOrdinal: 9,
            key: 'q',
            prompt: 'Orphan?',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
        changes: [],
      },
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('EXTRACTION_INCOHERENT');
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it.each([
    ['extraction_failed', 502, 'EXTRACTION_FAILED'],
    ['rate_limited', 429, 'EXTRACTOR_RATE_LIMITED'],
    ['no_provider_configured', 503, 'EXTRACTOR_UNAVAILABLE'],
  ])('maps dispatch error %s to HTTP %i (%s)', async (capCode, status, topCode) => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: capCode, message: 'boom' },
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(topCode);
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 503 EXTRACTOR_NOT_CONFIGURED when the extractor agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('EXTRACTOR_NOT_CONFIGURED');
    expect(reingestVersion).not.toHaveBeenCalled();
  });
});

// ─── Rate limit ─────────────────────────────────────────────────────────────────

describe('POST …/reingest — rate limit', () => {
  it('returns 429 when the per-admin sub-cap is exceeded, before any scope/parse work', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 0,
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(prisma.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
    expect(parseDocument).not.toHaveBeenCalled();
    expect(reingestVersion).not.toHaveBeenCalled();
  });
});
