/**
 * Integration test: respondent chat-transcript export routes (F7.6).
 *
 * Pins both routes' wiring: gate order (flag → load → access), both respondent access modes
 * (authenticated owner / anonymous session token), and the response envelopes — `application/pdf`
 * for `transcript.pdf` and `text/plain` for `transcript.txt`, each an `attachment` with the
 * `transcript-<slug>-v<N>.<ext>` filename and `no-store`. The DB seam + model assembly +
 * renderer are mocked (the builder + text serialiser are unit-tested separately), but the REAL
 * `resolveTurnAccess` runs (only the HMAC verify is stubbed), so 401/403/404 reflect real
 * access logic. The text route runs the REAL `buildTranscriptText` over the mocked model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const seamMock = vi.hoisted(() => ({
  loadTranscriptExport: vi.fn(),
  assembleTranscriptExportModel: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export', () => seamMock);

const renderMock = vi.hoisted(() => ({ renderTranscriptPdf: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf', () => renderMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET as GET_PDF } from '@/app/api/v1/app/questionnaire-sessions/[id]/transcript.pdf/route';
import { GET as GET_TXT } from '@/app/api/v1/app/questionnaire-sessions/[id]/transcript.txt/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  return {
    url: `http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/${path}`,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function model(over: Partial<TranscriptExportModel> = {}): TranscriptExportModel {
  return {
    questionnaireTitle: 'Onboarding survey',
    versionNumber: 2,
    goal: null,
    audienceSummary: null,
    refDisplay: '7F3K-9M2P',
    anonymous: false,
    respondentLabel: 'Ada',
    interviewerLabel: 'Interviewer',
    startedAt: '2026-06-01T09:55:00.000Z',
    completedAt: '2026-06-01T10:05:00.000Z',
    status: 'completed',
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
    turns: [
      { speaker: 'interviewer', text: 'Hello?', at: '2026-06-01T09:55:00.000Z' },
      { speaker: 'respondent', text: 'Hi.', at: '2026-06-01T10:00:00.000Z' },
    ],
    ...over,
  };
}

function loaded(respondentUserId: string | null) {
  return { session: { id: 'sess-1', respondentUserId } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  seamMock.loadTranscriptExport.mockResolvedValue(loaded(USER));
  seamMock.assembleTranscriptExportModel.mockResolvedValue(model());
  renderMock.renderTranscriptPdf.mockResolvedValue(Buffer.from('%PDF-1.7\n%mock'));
});

describe('transcript.pdf', () => {
  describe('gate order', () => {
    it('404s when the live-sessions flag is off, before auth or load', async () => {
      vi.mocked(isFeatureEnabled).mockResolvedValue(false);
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(404);
      expect(auth.api.getSession).not.toHaveBeenCalled();
      expect(seamMock.loadTranscriptExport).not.toHaveBeenCalled();
    });

    it('404s when the session does not exist (no access, no render)', async () => {
      seamMock.loadTranscriptExport.mockResolvedValue(null);
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(404);
      expect(auth.api.getSession).not.toHaveBeenCalled();
      expect(renderMock.renderTranscriptPdf).not.toHaveBeenCalled();
    });

    it('does not build/render before access is granted', async () => {
      setAuth(mockUnauthenticatedUser());
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(401);
      expect(seamMock.assembleTranscriptExportModel).not.toHaveBeenCalled();
      expect(renderMock.renderTranscriptPdf).not.toHaveBeenCalled();
    });
  });

  describe('authenticated access', () => {
    it('200s a PDF envelope for the owning user', async () => {
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toContain(
        'transcript-onboarding-survey-v2.pdf'
      );
      expect(res.headers.get('cache-control')).toBe('no-store');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
    });

    it('fetches the logo for the PDF (fetchLogo: true)', async () => {
      await GET_PDF(req('transcript.pdf'), ctx);
      expect(seamMock.assembleTranscriptExportModel).toHaveBeenCalledWith(expect.anything(), {
        fetchLogo: true,
      });
    });

    it('403s when the session belongs to another respondent', async () => {
      seamMock.loadTranscriptExport.mockResolvedValue(loaded('someone-else'));
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(403);
    });
  });

  describe('anonymous (no-login) access', () => {
    it('200s a valid session-token-bearing anonymous caller', async () => {
      setAuth(mockUnauthenticatedUser());
      tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
      seamMock.loadTranscriptExport.mockResolvedValue(loaded(null));
      const res = await GET_PDF(req('transcript.pdf', { 'x-session-token': 'tok.sig' }), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
    });

    it('401s an anonymous session with no token', async () => {
      setAuth(mockUnauthenticatedUser());
      seamMock.loadTranscriptExport.mockResolvedValue(loaded(null));
      const res = await GET_PDF(req('transcript.pdf'), ctx);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SESSION_TOKEN_REQUIRED');
    });
  });
});

describe('transcript.txt', () => {
  it('404s when the live-sessions flag is off, before load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET_TXT(req('transcript.txt'), ctx);
    expect(res.status).toBe(404);
    expect(seamMock.loadTranscriptExport).not.toHaveBeenCalled();
  });

  it('200s a text envelope with the real serialised transcript', async () => {
    const res = await GET_TXT(req('transcript.txt'), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('transcript-onboarding-survey-v2.txt');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('Conversation transcript');
    expect(text).toContain('] Interviewer:\nHello?');
    expect(text).toContain('] Ada:\nHi.');
  });

  it('skips the logo fetch for text (fetchLogo: false)', async () => {
    await GET_TXT(req('transcript.txt'), ctx);
    expect(seamMock.assembleTranscriptExportModel).toHaveBeenCalledWith(expect.anything(), {
      fetchLogo: false,
    });
  });

  it('403s when the session belongs to another respondent', async () => {
    seamMock.loadTranscriptExport.mockResolvedValue(loaded('someone-else'));
    const res = await GET_TXT(req('transcript.txt'), ctx);
    expect(res.status).toBe(403);
  });

  describe('anonymous (no-login) access', () => {
    it('200s a valid session-token-bearing anonymous caller', async () => {
      setAuth(mockUnauthenticatedUser());
      tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
      seamMock.loadTranscriptExport.mockResolvedValue(loaded(null));
      const res = await GET_TXT(req('transcript.txt', { 'x-session-token': 'tok.sig' }), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    });

    it('401s an anonymous session with no token', async () => {
      setAuth(mockUnauthenticatedUser());
      seamMock.loadTranscriptExport.mockResolvedValue(loaded(null));
      const res = await GET_TXT(req('transcript.txt'), ctx);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SESSION_TOKEN_REQUIRED');
    });
  });
});
