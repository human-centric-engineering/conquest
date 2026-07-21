/**
 * Integration test: admin session PDF export route (F7.4).
 *
 * Pins the route wiring: gate order (flag → admin auth → load → ownership), the
 * ownership check (the session's version must belong to the URL questionnaire), and the
 * PDF response envelope. The DB seam + model builder + renderer are mocked (the builder
 * is unit-tested and the render smoke-tested separately); `withAdminAuth` runs against a
 * mocked session so 401/403 reflect real guard logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const exportMock = vi.hoisted(() => ({
  loadSessionExport: vi.fn(),
  buildSessionExportPdfModel: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => exportMock);

const renderMock = vi.hoisted(() => ({ renderSessionPdf: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf', () => renderMock);

// The route asks for the report view to decide whether to embed insights — mock to "no report".
const reportViewMock = vi.hoisted(() => ({ buildRespondentReportClientView: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/view', () => reportViewMock);

import { GET } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/export.pdf/route';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

type Mock = ReturnType<typeof vi.fn>;
const URL_ = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/sessions/sess-1/export.pdf';

function req(): NextRequest {
  return { url: URL_, headers: new Headers() } as unknown as NextRequest;
}
function ctx(params: { id: string; sessionId: string }) {
  return { params: Promise.resolve(params) };
}
function setAuth(s: ReturnType<typeof mockAdminUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function model(over: Partial<SessionExportModel> = {}): SessionExportModel {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 1,
    ref: null,
    goal: null,
    audienceSummary: null,
    respondent: null,
    anonymous: true,
    profile: null,
    completedAt: null,
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: {
      ctaColor: '#000',
      accentColor: '#000',
      logoUrl: null,
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      hasBrandIdentity: false,
    },
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    narrative: false,
    includeQuestions: true,
    includeDataSlots: false,
    dataSlots: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  exportMock.loadSessionExport.mockResolvedValue({
    session: { id: 'sess-1', respondentUserId: 'u1' },
    questionnaireId: 'qn-1',
  });
  exportMock.buildSessionExportPdfModel.mockResolvedValue(model());
  renderMock.renderSessionPdf.mockResolvedValue(Buffer.from('%PDF-1.7\n%mock'));
  reportViewMock.buildRespondentReportClientView.mockResolvedValue(null);
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(401);
  });

  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(403);
  });
});

describe('ownership', () => {
  it('200s a PDF when the session belongs to the questionnaire', async () => {
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('404s when the session belongs to a different questionnaire (no render)', async () => {
    exportMock.loadSessionExport.mockResolvedValue({
      session: { id: 'sess-1', respondentUserId: 'u1' },
      questionnaireId: 'other-qn',
    });
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(404);
    expect(renderMock.renderSessionPdf).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    exportMock.loadSessionExport.mockResolvedValue(null);
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(404);
  });
});

describe('error handling', () => {
  it('500s with the error envelope when the render throws', async () => {
    renderMock.renderSessionPdf.mockRejectedValue(new Error('render failed'));
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBeDefined();
  });
});

describe('report embedding', () => {
  it('embeds a ready narrative report (content, narrative flag, data-slot config) into the model', async () => {
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      mode: 'narrative',
      includeData: { questions: true, dataSlots: true },
      insights: {
        status: 'ready',
        started: true,
        content: { summary: 'Respondent-facing narrative.' },
        formatted: true,
        completionPct: 100,
      },
    });

    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));

    expect(res.status).toBe(200);
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        insights: { summary: 'Respondent-facing narrative.' },
        narrative: true,
        includeQuestions: true, // admin PDF always keeps the full Q&A audit
        includeDataSlots: true,
        formatted: true,
        completionPct: 100,
      })
    );
  });

  it('embeds no insights when the report exists but is not ready yet', async () => {
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      mode: 'insights',
      includeData: { questions: true, dataSlots: false },
      insights: {
        status: 'queued',
        started: true,
        content: null,
        formatted: false,
        completionPct: null,
      },
    });

    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));

    expect(res.status).toBe(200);
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ insights: null, narrative: false, includeDataSlots: false })
    );
  });
});

describe('anonymous-mode redaction', () => {
  it('renders the redacted (anonymous) model the seam produced', async () => {
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(200);
    // The route renders exactly what buildSessionExportPdfModel returns — redaction is
    // applied there (anonymous → respondent: null), proven in the builder unit test.
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledTimes(1);
    expect(renderMock.renderSessionPdf).toHaveBeenCalledWith(
      expect.objectContaining({ anonymous: true, respondent: null })
    );
  });
});
