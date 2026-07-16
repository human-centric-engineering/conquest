/**
 * Integration test: admin chat-transcript export routes (P8 admin session views).
 *
 * The admin-side twins of the F7.6 respondent transcript exports. Pins the authorization that
 * makes them safe: the app-flag gate (404 before auth), admin-only access (401/403), and
 * questionnaire ownership (cross-questionnaire → 404, with NO render). On success they emit the
 * same envelopes as the respondent routes — `application/pdf` for `transcript.pdf` and
 * `text/plain` for `transcript.txt`, each an `attachment` with the `transcript-<slug>-v<N>.<ext>`
 * filename and `no-store`. The DB seam + model assembly + renderer are mocked; the REAL
 * `withAdminAuth` runs, so 401/403 reflect real auth logic. The text route runs the REAL
 * `buildTranscriptText` over the mocked model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn(() => Promise.resolve(null)),
  hasScope: vi.fn(() => false),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const seamMock = vi.hoisted(() => ({
  loadTranscriptExport: vi.fn(),
  assembleTranscriptExportModel: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export', () => seamMock);

const renderMock = vi.hoisted(() => ({ renderTranscriptPdf: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/render-transcript-pdf', () => renderMock);

import { GET as GET_PDF } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/transcript.pdf/route';
import { GET as GET_TXT } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/transcript.txt/route';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';

type Mock = ReturnType<typeof vi.fn>;
const QN = 'qn-1';
const SESSION = 'sess-1';

function req(headers: Record<string, string> = {}): NextRequest {
  return {
    url: 'http://localhost:3000/x',
    headers: new Headers(headers),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: QN, sessionId: SESSION }) };

function setAuth(s: ReturnType<typeof mockAdminUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

/** The shape `loadTranscriptExport` returns, trimmed to what the route reads. */
function loaded(over: Record<string, unknown> = {}) {
  return { session: { id: SESSION, respondentUserId: 'u-1' }, questionnaireId: QN, ...over };
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

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  seamMock.loadTranscriptExport.mockResolvedValue(loaded());
  seamMock.assembleTranscriptExportModel.mockResolvedValue(model());
  renderMock.renderTranscriptPdf.mockResolvedValue(Buffer.from('%PDF-1.7\n%mock'));
});

describe('admin transcript.pdf', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET_PDF(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await GET_PDF(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('404s when the session is unknown (no render)', async () => {
    seamMock.loadTranscriptExport.mockResolvedValue(null);
    const res = await GET_PDF(req(), ctx);
    expect(res.status).toBe(404);
    expect(renderMock.renderTranscriptPdf).not.toHaveBeenCalled();
  });

  it('404s when the session belongs to another questionnaire (no render)', async () => {
    seamMock.loadTranscriptExport.mockResolvedValue(loaded({ questionnaireId: 'other-qn' }));
    const res = await GET_PDF(req(), ctx);
    expect(res.status).toBe(404);
    expect(seamMock.assembleTranscriptExportModel).not.toHaveBeenCalled();
    expect(renderMock.renderTranscriptPdf).not.toHaveBeenCalled();
  });

  it('200s a PDF envelope for an admin, fetching the logo', async () => {
    const res = await GET_PDF(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('transcript-onboarding-survey-v2.pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(seamMock.assembleTranscriptExportModel).toHaveBeenCalledWith(expect.anything(), {
      fetchLogo: true,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

describe('admin transcript.txt', () => {
  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await GET_TXT(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('404s when the session belongs to another questionnaire (no build)', async () => {
    seamMock.loadTranscriptExport.mockResolvedValue(loaded({ questionnaireId: 'other-qn' }));
    const res = await GET_TXT(req(), ctx);
    expect(res.status).toBe(404);
    expect(seamMock.assembleTranscriptExportModel).not.toHaveBeenCalled();
  });

  it('200s a text envelope with the real serialised transcript, skipping the logo fetch', async () => {
    const res = await GET_TXT(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('transcript-onboarding-survey-v2.txt');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(seamMock.assembleTranscriptExportModel).toHaveBeenCalledWith(expect.anything(), {
      fetchLogo: false,
    });
    const text = await res.text();
    expect(text).toContain('] Interviewer:\nHello?');
    expect(text).toContain('] Ada:\nHi.');
  });

  it('carries anonymous-mode redaction through — no respondent name in the body', async () => {
    seamMock.assembleTranscriptExportModel.mockResolvedValue(
      model({ anonymous: true, respondentLabel: 'Respondent' })
    );
    const res = await GET_TXT(req(), ctx);
    const text = await res.text();
    expect(text).not.toContain('Ada');
    expect(text).toContain('] Respondent:\nHi.');
  });
});
