/**
 * Integration test: admin session viewer routes (admin transcript read, preview-token mint, ref
 * lookup).
 *
 * Pins the authorization that makes the viewer safe: admin-only access, questionnaire ownership
 * (cross-questionnaire → 404), and the hard gate that an admin can mint a continue token ONLY for a
 * preview session — a real respondent session is structurally un-continuable (409 SESSION_NOT_PREVIEW).
 * The DB seams (`loadAdminSessionView`, `loadTranscript`, `resolveSessionRefLocation`) and the token
 * mint are mocked; the REAL `withAdminAuth` runs, so 401/403 reflect real auth logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn(() => Promise.resolve(null)),
  hasScope: vi.fn(() => false),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const viewMock = vi.hoisted(() => ({
  loadAdminSessionView: vi.fn(),
  resolveSessionRefLocation: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view', () => viewMock);

const transcriptMock = vi.hoisted(() => ({ loadTranscript: vi.fn(), loadInspectorTurns: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript', () => transcriptMock);

const tokenMock = vi.hoisted(() => ({ mintSessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

const dbMock = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => dbMock);

import { GET as getTranscript } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/transcript/route';
import { POST as postPreviewToken } from '@/app/api/v1/app/questionnaires/[id]/sessions/[sessionId]/preview-token/route';
import { GET as getByRef } from '@/app/api/v1/app/questionnaires/sessions/by-ref/[ref]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const QN = 'qn-1';
const SESSION = 'sess-1';

function req(headers: Record<string, string> = {}): NextRequest {
  return {
    url: 'http://localhost:3000/x',
    headers: new Headers(headers),
  } as unknown as NextRequest;
}
function setAuth(s: ReturnType<typeof mockAdminUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const transcriptCtx = { params: Promise.resolve({ id: QN, sessionId: SESSION }) };
const refCtx = { params: Promise.resolve({ ref: '7F3K-9M2P' }) };

function adminView(over: Record<string, unknown> = {}) {
  return {
    questionnaireId: QN,
    questionnaireTitle: 'Onboarding',
    versionId: 'v-1',
    versionNumber: 2,
    isPreview: false,
    status: 'completed',
    publicRef: '7F3K9M2P',
    anonymous: false,
    respondentName: 'Ada',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAdminUser());
  viewMock.loadAdminSessionView.mockResolvedValue(adminView());
  transcriptMock.loadTranscript.mockResolvedValue([
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Hello' },
  ]);
  tokenMock.mintSessionToken.mockReturnValue({
    token: 'tok.sig',
    expiresAt: new Date('2026-06-24T00:00:00.000Z'),
  });
});

describe('GET admin transcript', () => {
  it('404s when the app flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(viewMock.loadAdminSessionView).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(401);
  });

  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(403);
  });

  it('404s when the session is unknown', async () => {
    viewMock.loadAdminSessionView.mockResolvedValue(null);
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(404);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('404s when the session belongs to another questionnaire (no transcript read)', async () => {
    viewMock.loadAdminSessionView.mockResolvedValue(adminView({ questionnaireId: 'other-qn' }));
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(404);
    expect(transcriptMock.loadTranscript).not.toHaveBeenCalled();
  });

  it('200s with turns + metadata for an admin', async () => {
    const res = await getTranscript(req(), transcriptCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.turns).toHaveLength(2);
    expect(body.data.isPreview).toBe(false);
    expect(body.data.respondentName).toBe('Ada');
    expect(body.data.publicRef).toBe('7F3K9M2P');
  });

  it('carries the export redaction through — no respondent name in anonymous mode', async () => {
    viewMock.loadAdminSessionView.mockResolvedValue(
      adminView({ anonymous: true, respondentName: null })
    );
    const res = await getTranscript(req(), transcriptCtx);
    const body = await res.json();
    expect(body.data.anonymous).toBe(true);
    expect(body.data.respondentName).toBeNull();
  });
});

describe('POST preview-token', () => {
  function previewCtx() {
    return { params: Promise.resolve({ id: QN, sessionId: SESSION }) };
  }
  function dbSession(over: Record<string, unknown> = {}) {
    return { isPreview: true, status: 'active', version: { questionnaireId: QN }, ...over };
  }

  beforeEach(() => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(dbSession());
  });

  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await postPreviewToken(req(), previewCtx());
    expect(res.status).toBe(403);
  });

  it('404s when the session belongs to another questionnaire', async () => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      dbSession({ version: { questionnaireId: 'other-qn' } })
    );
    const res = await postPreviewToken(req(), previewCtx());
    expect(res.status).toBe(404);
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('409s SESSION_NOT_PREVIEW for a real respondent session (the read-only gate)', async () => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      dbSession({ isPreview: false })
    );
    const res = await postPreviewToken(req(), previewCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_PREVIEW');
    expect(tokenMock.mintSessionToken).not.toHaveBeenCalled();
  });

  it('409s SESSION_NOT_ACTIVE for a preview that is no longer active', async () => {
    dbMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      dbSession({ status: 'completed' })
    );
    const res = await postPreviewToken(req(), previewCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('200s and mints a token for an active preview session', async () => {
    const res = await postPreviewToken(req(), previewCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accessToken).toBe('tok.sig');
    expect(tokenMock.mintSessionToken).toHaveBeenCalledWith(SESSION);
  });
});

describe('GET session by-ref', () => {
  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await getByRef(req(), refCtx);
    expect(res.status).toBe(403);
  });

  it('404s when no session matches the reference', async () => {
    viewMock.resolveSessionRefLocation.mockResolvedValue(null);
    const res = await getByRef(req(), refCtx);
    expect(res.status).toBe(404);
  });

  it('200s with the session location for an admin', async () => {
    viewMock.resolveSessionRefLocation.mockResolvedValue({
      sessionId: SESSION,
      ref: '7F3K9M2P',
      questionnaireId: QN,
      versionId: 'v-1',
      versionNumber: 2,
      questionnaireTitle: 'Onboarding',
      isPreview: true,
      status: 'active',
    });
    const res = await getByRef(req(), refCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sessionId).toBe(SESSION);
    expect(body.data.questionnaireId).toBe(QN);
    expect(body.data.versionId).toBe('v-1');
  });
});
