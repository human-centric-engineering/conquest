/**
 * Integration test: respondent session PDF export route (F7.4).
 *
 * Pins the route wiring: gate order (flag → load → access), both respondent access modes
 * (authenticated owner / anonymous session token), and the PDF response envelope
 * (content-type, attachment disposition, `%PDF` body). The DB seam + model builder +
 * renderer are mocked — the builder is unit-tested and the render smoke-tested
 * separately — but the REAL `resolveTurnAccess` runs (only the HMAC verify is stubbed),
 * so 401/403/404 reflect real access logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const exportMock = vi.hoisted(() => ({
  loadSessionExport: vi.fn(),
  buildSessionExportPdfModel: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => exportMock);

const renderMock = vi.hoisted(() => ({ renderSessionPdf: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf', () => renderMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

// The route asks for the report view to decide whether to embed insights — mock it to "no report".
const reportViewMock = vi.hoisted(() => ({ buildRespondentReportClientView: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/view', () => reportViewMock);

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/export.pdf/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL_ = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/export.pdf';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL_, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function model(over: Partial<SessionExportModel> = {}): SessionExportModel {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 2,
    ref: 'GSP289HB',
    goal: null,
    audienceSummary: null,
    respondent: { name: 'Ada' },
    anonymous: false,
    profile: null,
    completedAt: '2026-06-01T10:00:00.000Z',
    generatedAt: '2026-06-07T12:00:00.000Z',
    theme: {
      ctaColor: '#000',
      accentColor: '#000',
      logoUrl: null,
      welcomeCopy: 'hi',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
    },
    sections: [],
    answeredCount: 1,
    totalCount: 2,
    ...over,
  };
}

function loaded(respondentUserId: string | null) {
  return { session: { id: 'sess-1', respondentUserId }, questionnaireId: 'qn-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  exportMock.loadSessionExport.mockResolvedValue(loaded(USER));
  exportMock.buildSessionExportPdfModel.mockResolvedValue(model());
  reportViewMock.buildRespondentReportClientView.mockResolvedValue(null);
  renderMock.renderSessionPdf.mockResolvedValue(Buffer.from('%PDF-1.7\n%mock'));
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(exportMock.loadSessionExport).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist (no access resolved, no render)', async () => {
    exportMock.loadSessionExport.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(renderMock.renderSessionPdf).not.toHaveBeenCalled();
  });

  it('does not build/render before access is granted', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(exportMock.buildSessionExportPdfModel).not.toHaveBeenCalled();
    expect(renderMock.renderSessionPdf).not.toHaveBeenCalled();
  });

  it('500s when the render throws', async () => {
    renderMock.renderSessionPdf.mockRejectedValue(new Error('render failed'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
  });
});

describe('authenticated access', () => {
  it('200s a PDF for the owning user', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="responses-/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('names the file from the questionnaire title + version', async () => {
    const res = await GET(req(), ctx);
    expect(res.headers.get('content-disposition')).toContain('responses-onboarding-survey-v2.pdf');
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('403s when the session belongs to another respondent', async () => {
    exportMock.loadSessionExport.mockResolvedValue(loaded('someone-else'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
  });
});

describe('respondent report embedding', () => {
  const readyContent = { summary: 'Your story.', sections: [], actions: ['Do X'] };

  it('embeds a ready narrative report and renders it woven-only (narrativeOnly)', async () => {
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        content: readyContent,
        formatted: true,
        completionPct: 100,
        generatedAt: null,
        error: null,
      },
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    // The report-embed options object carries the formatter flag + completion %, threaded from the
    // ready report so the PDF trusts its layout and can render the partial caveat.
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(expect.anything(), {
      insights: readyContent,
      narrativeOnly: true,
      formatted: true,
      completionPct: 100,
    });
  });

  it('threads a partial completion % so the PDF can render the caveat (mode-2, narrativeOnly false)', async () => {
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        content: readyContent,
        formatted: false,
        completionPct: 40, // below the caveat threshold — must reach the PDF builder
        generatedAt: null,
        error: null,
      },
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(expect.anything(), {
      insights: readyContent,
      narrativeOnly: false,
      formatted: false,
      completionPct: 40,
    });
  });

  it('trusts the formatter layout for a formatted mode-2 report (narrativeOnly false, formatted true)', async () => {
    // narrativeOnly=false but formatted=true — an options object (not positional args) so a swap of
    // the two flags is structurally impossible, but this still documents the divergent combination.
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      enabled: true,
      mode: 'raw_plus_insights',
      onScreen: true,
      download: true,
      insights: {
        status: 'ready',
        content: readyContent,
        formatted: true,
        completionPct: 100,
        generatedAt: null,
        error: null,
      },
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(expect.anything(), {
      insights: readyContent,
      narrativeOnly: false,
      formatted: true,
      completionPct: 100,
    });
  });

  it('passes no insights and no narrative layout when the report is not ready', async () => {
    reportViewMock.buildRespondentReportClientView.mockResolvedValue({
      enabled: true,
      mode: 'narrative',
      onScreen: true,
      download: true,
      insights: {
        status: 'processing',
        content: null,
        // `formatted: true` / `completionPct: 40` in the (non-ready) row must NOT leak through — the
        // route zeroes both unless the report is ready. Asserting the defaults below proves the gate.
        formatted: true,
        completionPct: 40,
        generatedAt: null,
        error: null,
      },
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    // Not ready → no insights, no narrative layout, formatter flag false, no completion % (no caveat).
    expect(exportMock.buildSessionExportPdfModel).toHaveBeenCalledWith(expect.anything(), {
      insights: null,
      narrativeOnly: false,
      formatted: false,
      completionPct: null,
    });
  });
});

describe('anonymous (no-login) access', () => {
  it('200s a valid session-token-bearing anonymous caller', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    exportMock.loadSessionExport.mockResolvedValue(loaded(null));
    const res = await GET(req({ 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
  });

  it('401s an anonymous session with no token', async () => {
    setAuth(mockUnauthenticatedUser());
    exportMock.loadSessionExport.mockResolvedValue(loaded(null));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('SESSION_TOKEN_REQUIRED');
  });
});
