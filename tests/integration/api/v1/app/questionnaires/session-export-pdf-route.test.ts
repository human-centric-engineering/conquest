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

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const exportMock = vi.hoisted(() => ({
  loadSessionExport: vi.fn(),
  buildSessionExportPdfModel: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-export', () => exportMock);

const renderMock = vi.hoisted(() => ({ renderSessionPdf: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/render-session-pdf', () => renderMock);

import { GET } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/export.pdf/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
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
    },
    sections: [],
    answeredCount: 0,
    totalCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAdminUser());
  exportMock.loadSessionExport.mockResolvedValue({
    session: { id: 'sess-1', respondentUserId: 'u1' },
    questionnaireId: 'qn-1',
  });
  exportMock.buildSessionExportPdfModel.mockResolvedValue(model());
  renderMock.renderSessionPdf.mockResolvedValue(Buffer.from('%PDF-1.7\n%mock'));
});

describe('gate order + auth', () => {
  it('404s when the app flag is off, before admin auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET(req(), ctx({ id: 'qn-1', sessionId: 'sess-1' }));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(exportMock.loadSessionExport).not.toHaveBeenCalled();
  });

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
