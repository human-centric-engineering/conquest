/**
 * Unit tests for the Questionnaire Pack download route.
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/route.ts
 *
 * Every collaborator is mocked at the module boundary, modelled directly on
 * instrument-route.test.ts. @react-pdf/renderer is never actually imported: renderPackPdf is
 * mocked at the route-local seam so no real PDF render runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/auth/guards', () => ({
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
          const apiErr = error as { status: number; code: string; message: string };
          return Response.json(
            { success: false, error: { message: apiErr.message, code: apiErr.code } },
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
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  exportLimiter: { check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })) },
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaire: { findUnique: vi.fn() } },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getVersionGraph: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-routes', () => ({
  loadDataSlots: vi.fn(async () => []),
}));

vi.mock('@/lib/app/questionnaire/glossary/resolve', () => ({
  loadAcceptedGlossaryEntries: vi.fn(async () => []),
}));

vi.mock('@/lib/app/questionnaire/glossary/report-appendix', () => ({
  buildGlossaryAppendix: vi.fn(() => null),
}));

vi.mock('@/lib/app/questionnaire/export/build-pack-model', () => ({
  buildPackModel: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/export/build-pack-markdown', () => ({
  buildPackMarkdown: vi.fn(() => '# Markdown pack content'),
}));

vi.mock('@/lib/app/questionnaire/export/build-pack-csv', () => ({
  buildPackCsv: vi.fn(() => '# Meta\r\nfield,value\r\nTitle,Test'),
}));

vi.mock('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf', () => ({
  renderPackPdf: vi.fn(async () => Buffer.from('%PDF-1.4 mock content')),
}));

// ─── Deferred imports (after vi.mock) ─────────────────────────────────────────

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { GET } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/route')) as {
    GET: AnyRouteHandler;
  };

import { exportLimiter } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { loadDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { buildGlossaryAppendix } from '@/lib/app/questionnaire/glossary/report-appendix';
import { buildPackModel } from '@/lib/app/questionnaire/export/build-pack-model';
import { buildPackMarkdown } from '@/lib/app/questionnaire/export/build-pack-markdown';
import { buildPackCsv } from '@/lib/app/questionnaire/export/build-pack-csv';
import { renderPackPdf } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/pack/render-pack-pdf';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

const GRAPH = { versionNumber: 2, sections: [], goal: 'Goal', audience: null, config: {} };
const QUESTIONNAIRE_ROW = { title: 'Onboarding Check' };
const PACK_MODEL = { title: 'Onboarding Check', generatedAt: '2026-01-01T00:00:00.000Z' };

function makeRequest(id = QN_ID, vid = VID, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/v1/app/questionnaires/${id}/versions/${vid}/pack`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

function makeContext(id = QN_ID, vid = VID) {
  return { params: Promise.resolve({ id, vid }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  (exportLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(QUESTIONNAIRE_ROW);
  (getVersionGraph as Mock).mockResolvedValue(GRAPH);
  (loadDataSlots as Mock).mockResolvedValue([]);
  (buildPackModel as Mock).mockReturnValue(PACK_MODEL);
});

// ─── Rate limit / not found ────────────────────────────────────────────────────

describe('GET pack — rate limit', () => {
  it('returns the createRateLimitResponse result when exportLimiter rejects', async () => {
    (exportLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 9_999_999_999,
    });

    const res = await GET(makeRequest(), ADMIN_SESSION, makeContext());

    expect(res.status).toBe(429);
    expect(exportLimiter.check).toHaveBeenCalledWith('export:user:admin-1');
    expect(getVersionGraph).not.toHaveBeenCalled();
    expect(buildPackModel).not.toHaveBeenCalled();
  });
});

describe('GET pack — not found', () => {
  it('returns 404 when the questionnaire row is missing', async () => {
    (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(null);
    const res = await GET(makeRequest(), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(404);
    expect(buildPackModel).not.toHaveBeenCalled();
  });

  it('returns 404 when the version graph is missing', async () => {
    (getVersionGraph as Mock).mockResolvedValue(null);
    const res = await GET(makeRequest(), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(404);
    expect(buildPackModel).not.toHaveBeenCalled();
  });
});

describe('GET pack — format validation', () => {
  it('returns 400 when format is not a valid enum value', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'xml' }), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(400);
    expect(buildPackModel).not.toHaveBeenCalled();
  });
});

// ─── Include flags ──────────────────────────────────────────────────────────────

describe('GET pack — include flags', () => {
  it('defaults every include flag to true when omitted', async () => {
    await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    expect(buildPackModel).toHaveBeenCalledWith(
      QUESTIONNAIRE_ROW.title,
      GRAPH,
      [],
      null,
      { meta: true, questions: true, dataSlots: true, definitions: true, setup: true },
      expect.any(String)
    );
  });

  it('threads individual include=false flags through to buildPackModel', async () => {
    await GET(
      makeRequest(QN_ID, VID, { format: 'md', dataSlots: 'false', setup: 'false' }),
      ADMIN_SESSION,
      makeContext()
    );
    expect(buildPackModel).toHaveBeenCalledWith(
      QUESTIONNAIRE_ROW.title,
      GRAPH,
      [],
      null,
      { meta: true, questions: true, dataSlots: false, definitions: true, setup: false },
      expect.any(String)
    );
  });

  it('skips loading the glossary appendix when definitions=false', async () => {
    await GET(
      makeRequest(QN_ID, VID, { format: 'md', definitions: 'false' }),
      ADMIN_SESSION,
      makeContext()
    );
    expect(buildGlossaryAppendix).not.toHaveBeenCalled();
  });

  it('loads the glossary appendix when definitions=true (default)', async () => {
    await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    expect(buildGlossaryAppendix).toHaveBeenCalled();
  });
});

// ─── Format: md ─────────────────────────────────────────────────────────────────

describe('GET pack — format=md', () => {
  it('returns 200 with text/markdown content-type and .md attachment filename', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/\.md"$/);
  });

  it('calls buildPackMarkdown with the model and returns its output', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    const text = await res.text();
    expect(buildPackMarkdown).toHaveBeenCalledWith(PACK_MODEL);
    expect(buildPackCsv).not.toHaveBeenCalled();
    expect(renderPackPdf).not.toHaveBeenCalled();
    expect(text).toBe('# Markdown pack content');
  });
});

// ─── Format: csv ────────────────────────────────────────────────────────────────

describe('GET pack — format=csv', () => {
  it('returns 200 with text/csv content-type and .csv attachment filename', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'csv' }), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/\.csv"$/);
  });

  it('calls buildPackCsv with the model and returns its output', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'csv' }), ADMIN_SESSION, makeContext());
    const text = await res.text();
    expect(buildPackCsv).toHaveBeenCalledWith(PACK_MODEL);
    expect(buildPackMarkdown).not.toHaveBeenCalled();
    expect(text).toBe('# Meta\r\nfield,value\r\nTitle,Test');
  });
});

// ─── Format: pdf (default) ────────────────────────────────────────────────────

describe('GET pack — format=pdf (default)', () => {
  it('defaults to pdf when the format param is omitted', async () => {
    const res = await GET(makeRequest(), ADMIN_SESSION, makeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(renderPackPdf).toHaveBeenCalledWith(PACK_MODEL);
  });

  it('returns binary content and .pdf attachment filename', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content for test');
    (renderPackPdf as Mock).mockResolvedValue(pdfBytes);

    const res = await GET(makeRequest(QN_ID, VID, { format: 'pdf' }), ADMIN_SESSION, makeContext());
    expect(res.headers.get('Content-Disposition')).toMatch(/\.pdf"$/);
    const arrayBuffer = await res.arrayBuffer();
    expect(Buffer.from(arrayBuffer).toString()).toBe(pdfBytes.toString());
  });
});

// ─── Common behaviour ───────────────────────────────────────────────────────────

describe('GET pack — common behaviour', () => {
  it('sets Cache-Control: no-store', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('includes the slugified title and version number in the filename', async () => {
    const res = await GET(makeRequest(QN_ID, VID, { format: 'md' }), ADMIN_SESSION, makeContext());
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('onboarding-check');
    expect(disposition).toContain('-v2');
  });

  it('uses the id and vid path params to scope the version graph lookup', async () => {
    await GET(
      makeRequest('qn-999', 'ver-999', { format: 'md' }),
      ADMIN_SESSION,
      makeContext('qn-999', 'ver-999')
    );
    expect(getVersionGraph).toHaveBeenCalledWith('qn-999', 'ver-999');
    expect(loadDataSlots).toHaveBeenCalledWith('ver-999');
  });
});
