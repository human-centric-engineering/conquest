/**
 * Integration test: session lifecycle transition route (F4.6).
 *
 * Exercises the POST handler with the DB (`prisma`) and the session seam
 * (`_lib/sessions`) mocked: gate order (auth → validation → scope), the
 * action dispatch (pause/resume/abandon → the right seam call), the resume payload, and
 * the 409 mapping of an illegal transition. The pure transition rules are unit-tested
 * (session-logic.test.ts) and the seam's writes in session-state-machine.test.ts; this
 * pins the route's orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const seamMock = vi.hoisted(() => ({
  pauseSession: vi.fn(),
  resumeSession: vi.fn(),
  abandonSession: vi.fn(),
  loadSessionResumeState: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => seamMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sessions/[sessionId]/transition/route';

import { auth } from '@/lib/auth/config';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const PARAMS = { id: 'qn-1', vid: 'v1', sessionId: 'sess-1' };
const URL =
  'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/sessions/sess-1/transition';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(sessionVal: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(sessionVal);
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-1' });
  seamMock.pauseSession.mockResolvedValue('paused');
  seamMock.resumeSession.mockResolvedValue('active');
  seamMock.abandonSession.mockResolvedValue('abandoned');
  seamMock.loadSessionResumeState.mockResolvedValue({
    status: 'active',
    answeredSlots: [{ slotKey: 'age', value: 30, provenance: 'direct', confidence: 0.9 }],
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({ action: 'pause' }), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req({ action: 'pause' }), ctx(PARAMS))).status).toBe(403);
  });

  it('rejects an invalid action (400) before touching the seam', async () => {
    const res = await POST(req({ action: 'finish' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(seamMock.pauseSession).not.toHaveBeenCalled();
  });

  it('404s when the session does not belong to the version/questionnaire', async () => {
    prismaMock.appQuestionnaireSession.findFirst.mockResolvedValue(null);
    const res = await POST(req({ action: 'pause' }), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(seamMock.pauseSession).not.toHaveBeenCalled();
  });

  it('excludes the preview session from the scope (isPreview: false) — preview is 404', async () => {
    // The scope query carries isPreview: false, so the F4.4/F4.5 preview singleton can't
    // be paused/abandoned here (which would brick that version's /complete submit). The
    // mock honours the filter: a preview-only session resolves to null → 404.
    await POST(req({ action: 'pause' }), ctx(PARAMS));
    expect(prismaMock.appQuestionnaireSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'sess-1',
          versionId: 'v1',
          isPreview: false,
          version: { questionnaireId: 'qn-1' },
        },
      })
    );
  });
});

describe('action dispatch', () => {
  it('pause → calls pauseSession and returns the new status', async () => {
    const res = await POST(req({ action: 'pause' }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(seamMock.pauseSession).toHaveBeenCalledWith('sess-1', {});
    expect(body.data).toEqual({ sessionId: 'sess-1', status: 'paused' });
    expect(seamMock.loadSessionResumeState).not.toHaveBeenCalled();
  });

  it('abandon → calls abandonSession and returns the new status', async () => {
    const res = await POST(req({ action: 'abandon' }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(seamMock.abandonSession).toHaveBeenCalledWith('sess-1', {});
    expect(body.data).toEqual({ sessionId: 'sess-1', status: 'abandoned' });
  });

  it('resume → calls resumeSession then returns the resume state', async () => {
    const res = await POST(req({ action: 'resume' }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(seamMock.resumeSession).toHaveBeenCalledWith('sess-1', {});
    expect(seamMock.loadSessionResumeState).toHaveBeenCalledWith('sess-1');
    expect(body.data).toEqual({
      sessionId: 'sess-1',
      status: 'active',
      answeredSlots: [{ slotKey: 'age', value: 30, provenance: 'direct', confidence: 0.9 }],
    });
  });

  it('threads an optional reason onto the seam call', async () => {
    await POST(req({ action: 'abandon', reason: 'timed out' }), ctx(PARAMS));
    expect(seamMock.abandonSession).toHaveBeenCalledWith('sess-1', { reason: 'timed out' });
  });
});

describe('illegal transition → 409', () => {
  it('maps a SessionTransitionError from the seam to a 409 with the from/to in the envelope', async () => {
    seamMock.pauseSession.mockRejectedValue(new SessionTransitionError('completed', 'paused'));
    const res = await POST(req({ action: 'pause' }), ctx(PARAMS));
    expect(res.status).toBe(409);
    const body = await res.json();
    // The route wraps the error in a ConflictError carrying { from, to } — that payload
    // is the contract, so pin the code + details, not just the envelope baseline.
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details).toEqual({ from: 'completed', to: 'paused' });
  });

  it('rejects resuming a completed session with 409 and does not load resume state', async () => {
    seamMock.resumeSession.mockRejectedValue(new SessionTransitionError('completed', 'active'));
    const res = await POST(req({ action: 'resume' }), ctx(PARAMS));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.details).toEqual({ from: 'completed', to: 'active' });
    expect(seamMock.loadSessionResumeState).not.toHaveBeenCalled();
  });
});
