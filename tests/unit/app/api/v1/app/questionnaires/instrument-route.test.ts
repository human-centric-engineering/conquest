/**
 * Unit tests for the blank-instrument download route (F14.9).
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/instrument/route.ts
 *
 * Every collaborator is mocked at the module boundary. Tests assert what the
 * route DOES — status codes, content-type headers, which builder was called —
 * not just what mocks return (anti-green-bar).
 *
 * @react-pdf/renderer is never actually imported: renderInstrumentPdf is mocked
 * at the route-local seam so no real PDF render runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  withQuestionnairesEnabled: (handler: unknown) => handler,
}));

vi.mock('@/lib/auth/guards', () => ({
  // More realistic than the plain identity mock: still bypasses auth (passes args through),
  // but preserves withAdminAuth's try/catch so tests can assert on error responses rather
  // than catching thrown errors. Matches the real handleAPIError envelope for APIError
  // subclasses (ValidationError, NotFoundError, etc.).
  withAdminAuth:
    (handler: unknown) =>
    async (...args: unknown[]) => {
      try {
        return await (handler as (...args: unknown[]) => Promise<Response>)(...args);
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'status' in error &&
          'code' in error &&
          'message' in error
        ) {
          const apiErr = error as {
            status: number;
            code: string;
            message: string;
            details?: Record<string, unknown>;
          };
          return Response.json(
            {
              success: false,
              error: {
                message: apiErr.message,
                ...(apiErr.code ? { code: apiErr.code } : {}),
                ...(apiErr.details !== undefined ? { details: apiErr.details } : {}),
              },
            },
            { status: apiErr.status }
          );
        }
        return Response.json(
          { success: false, error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
          { status: 500 }
        );
      }
    },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  exportLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findUnique: vi.fn() },
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getVersionGraph: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/export/build-instrument-model', () => ({
  buildInstrumentModel: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/export/build-instrument-text', () => ({
  buildInstrumentText: vi.fn(() => 'plain text instrument content'),
}));

vi.mock('@/lib/app/questionnaire/export/build-instrument-csv', () => ({
  buildInstrumentCsv: vi.fn(() => 'section,question,type\n1,Your name?,free_text'),
}));

// Mock the PDF renderer so @react-pdf/renderer never runs
vi.mock(
  '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/instrument/render-instrument-pdf',
  () => ({
    renderInstrumentPdf: vi.fn(async () => Buffer.from('%PDF-1.4 mock content')),
  })
);

// ─── Deferred imports (after vi.mock) ─────────────────────────────────────────

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { GET } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/instrument/route')) as {
    GET: AnyRouteHandler;
  };

import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { buildInstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';
import { buildInstrumentText } from '@/lib/app/questionnaire/export/build-instrument-text';
import { buildInstrumentCsv } from '@/lib/app/questionnaire/export/build-instrument-csv';
import { renderInstrumentPdf } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/instrument/render-instrument-pdf';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

const GRAPH = {
  versionNumber: 2,
  status: 'launched',
  sections: [{ id: 'sec-1', title: 'About You', ordinal: 0, questions: [] }],
  goal: 'Assess readiness',
  audience: null,
};

const QUESTIONNAIRE_ROW = { title: 'Onboarding Check' };

const INSTRUMENT_MODEL = {
  title: 'Onboarding Check',
  generatedAt: '2026-01-01T00:00:00.000Z',
  sections: [],
};

function makeRequest(id = QN_ID, vid = VID, format?: string) {
  const url = new URL(
    `http://localhost/api/v1/app/questionnaires/${id}/versions/${vid}/instrument`
  );
  if (format) url.searchParams.set('format', format);
  return new NextRequest(url.toString());
}

function makeContext(id = QN_ID, vid = VID) {
  return { params: Promise.resolve({ id, vid }) };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Rate limit passes by default
  (exportLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });

  // DB lookups succeed by default
  (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(QUESTIONNAIRE_ROW);
  (getVersionGraph as Mock).mockResolvedValue(GRAPH);

  // Builder returns a canonical model
  (buildInstrumentModel as Mock).mockReturnValue(INSTRUMENT_MODEL);
});

// ─── Feature-flag gate (withQuestionnairesEnabled mock wiring) ────────────────

describe('feature-flag gate (withQuestionnairesEnabled mock wiring)', () => {
  it('allows the handler to run when the flag mock is the identity function', async () => {
    (exportLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 0,
    });

    const req = makeRequest();
    await GET(req, ADMIN_SESSION, makeContext());

    // createRateLimitResponse called → handler body ran → identity wrapper is transparent
    expect(createRateLimitResponse).toHaveBeenCalledOnce();
  });
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

describe('GET instrument — rate limit', () => {
  it('returns the createRateLimitResponse result when exportLimiter rejects', async () => {
    (exportLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 9_999_999_999,
    });

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(createRateLimitResponse).toHaveBeenCalledOnce();
    expect(res).toBe(vi.mocked(createRateLimitResponse).mock.results[0]?.value);
    expect(res.status).toBe(429);

    // Rate limit key is scoped by user id
    expect(exportLimiter.check).toHaveBeenCalledWith('export:user:admin-1');

    // No downstream work should have happened
    expect(getVersionGraph).not.toHaveBeenCalled();
    expect(buildInstrumentModel).not.toHaveBeenCalled();
  });
});

// ─── Not found ────────────────────────────────────────────────────────────────

describe('GET instrument — not found', () => {
  it('returns 404 NOT_FOUND when the questionnaire row is missing', async () => {
    (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(null);

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    expect(buildInstrumentModel).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND when the version graph is missing', async () => {
    (getVersionGraph as Mock).mockResolvedValue(null);

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    expect(buildInstrumentModel).not.toHaveBeenCalled();
  });
});

// ─── Format validation ────────────────────────────────────────────────────────

describe('GET instrument — format validation', () => {
  it('returns 400 VALIDATION_ERROR when format is not a valid enum value', async () => {
    // validateQueryParams runs the real Zod schema (not mocked); format=xml fails
    // the .enum(['pdf','text','csv']) check and throws ValidationError, which
    // withAdminAuth catches and converts to the standard error envelope.
    const req = makeRequest(QN_ID, VID, 'xml');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Validation is checked before any builder is reached
    expect(buildInstrumentModel).not.toHaveBeenCalled();
    expect(buildInstrumentText).not.toHaveBeenCalled();
    expect(buildInstrumentCsv).not.toHaveBeenCalled();
    expect(renderInstrumentPdf).not.toHaveBeenCalled();
  });
});

// ─── Format: text ─────────────────────────────────────────────────────────────

describe('GET instrument — format=text', () => {
  it('returns 200 with text/plain content-type and .txt attachment filename', async () => {
    const req = makeRequest(QN_ID, VID, 'text');
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toMatch(/\.txt"$/);
  });

  it('calls buildInstrumentText with the model and returns its output', async () => {
    (buildInstrumentText as Mock).mockReturnValue('## Section 1\n1. Your name?');

    const req = makeRequest(QN_ID, VID, 'text');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const text = await res.text();

    // The route called the text builder — not the CSV or PDF builder
    expect(buildInstrumentText).toHaveBeenCalledWith(INSTRUMENT_MODEL);
    expect(buildInstrumentCsv).not.toHaveBeenCalled();
    expect(renderInstrumentPdf).not.toHaveBeenCalled();

    // The response body is what the builder returned, proving it was serialised correctly
    expect(text).toBe('## Section 1\n1. Your name?');
  });

  it('includes the slugified title and version number in the filename', async () => {
    const req = makeRequest(QN_ID, VID, 'text');
    const res = await GET(req, ADMIN_SESSION, makeContext());

    const disposition = res.headers.get('Content-Disposition') ?? '';
    // Title "Onboarding Check" → slug "onboarding-check", versionNumber is 2
    expect(disposition).toContain('onboarding-check');
    expect(disposition).toContain('-v2');
  });
});

// ─── Format: csv ──────────────────────────────────────────────────────────────

describe('GET instrument — format=csv', () => {
  it('returns 200 with text/csv content-type and .csv attachment filename', async () => {
    const req = makeRequest(QN_ID, VID, 'csv');
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toMatch(/\.csv"$/);
  });

  it('calls buildInstrumentCsv with the model and returns its output', async () => {
    const csvContent = 'section,question,type\n1,Your name?,free_text';
    (buildInstrumentCsv as Mock).mockReturnValue(csvContent);

    const req = makeRequest(QN_ID, VID, 'csv');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const text = await res.text();

    // The route called the CSV builder — not the text or PDF builder
    expect(buildInstrumentCsv).toHaveBeenCalledWith(INSTRUMENT_MODEL);
    expect(buildInstrumentText).not.toHaveBeenCalled();
    expect(renderInstrumentPdf).not.toHaveBeenCalled();

    expect(text).toBe(csvContent);
  });
});

// ─── Format: pdf (default) ────────────────────────────────────────────────────

describe('GET instrument — format=pdf (default)', () => {
  it('returns 200 with application/pdf content-type and .pdf attachment filename', async () => {
    const req = makeRequest(QN_ID, VID, 'pdf');
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toMatch(/\.pdf"$/);
  });

  it('defaults to pdf when the format param is omitted', async () => {
    // No format param → route defaults to 'pdf'
    const req = makeRequest(QN_ID, VID);
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(renderInstrumentPdf).toHaveBeenCalledWith(INSTRUMENT_MODEL);
  });

  it('calls renderInstrumentPdf with the model and returns binary content', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content for test');
    (renderInstrumentPdf as Mock).mockResolvedValue(pdfBytes);

    const req = makeRequest(QN_ID, VID, 'pdf');
    const res = await GET(req, ADMIN_SESSION, makeContext());

    // The route called the PDF renderer — not the text or CSV builder
    expect(renderInstrumentPdf).toHaveBeenCalledWith(INSTRUMENT_MODEL);
    expect(buildInstrumentText).not.toHaveBeenCalled();
    expect(buildInstrumentCsv).not.toHaveBeenCalled();

    // Response body is the rendered bytes (Uint8Array from Buffer)
    const arrayBuffer = await res.arrayBuffer();
    expect(Buffer.from(arrayBuffer).toString()).toBe(pdfBytes.toString());
  });
});

// ─── Common: Cache-Control and params scoping ─────────────────────────────────

describe('GET instrument — common behaviour', () => {
  // Separate tests per format so a failure names which format regressed.
  // Mock setup comes from the outer beforeEach — no in-test clearAllMocks needed.

  it('sets Cache-Control: no-store on pdf format response', async () => {
    const req = makeRequest(QN_ID, VID, 'pdf');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on text format response', async () => {
    const req = makeRequest(QN_ID, VID, 'text');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on csv format response', async () => {
    const req = makeRequest(QN_ID, VID, 'csv');
    const res = await GET(req, ADMIN_SESSION, makeContext());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('uses the id and vid path params to scope the version graph lookup', async () => {
    const req = makeRequest('qn-999', 'ver-999', 'text');
    await GET(req, ADMIN_SESSION, makeContext('qn-999', 'ver-999'));

    expect(getVersionGraph).toHaveBeenCalledWith('qn-999', 'ver-999');
    expect(prisma.appQuestionnaire.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'qn-999' } })
    );
  });

  it('passes the questionnaire title, graph, and a timestamp to buildInstrumentModel', async () => {
    const req = makeRequest(QN_ID, VID, 'text');
    await GET(req, ADMIN_SESSION, makeContext());

    expect(buildInstrumentModel).toHaveBeenCalledWith(
      QUESTIONNAIRE_ROW.title,
      GRAPH,
      expect.any(String) // ISO timestamp
    );
  });
});
