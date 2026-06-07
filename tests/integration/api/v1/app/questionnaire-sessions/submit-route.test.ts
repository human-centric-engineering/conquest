/**
 * Integration test: respondent submission route (F7.3).
 *
 * Pins the route wiring: gate order (flag → load → access → status → eligibility →
 * transition), idempotency on an already-completed session, the 409s for a non-active or
 * not-yet-offerable session, and the happy path that completes via `markSessionCompleted`.
 * The turn-context loader + the completion transition are mocked; the REAL pure
 * `assessCompletion`/`resolveCompletion` run, so eligibility reflects the real gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const ctxMock = vi.hoisted(() => ({ buildTurnContext: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turn-context', () => ctxMock);

const sessionsMock = vi.hoisted(() => ({ markSessionCompleted: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => sessionsMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/submit/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/submit';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

/** A loaded turn context. `offerable` = thresholds trivially met → assessCompletion 'offer'. */
function loadedContext(
  opts: { status?: string; respondentUserId?: string | null; offerable?: boolean } = {}
) {
  const { status = 'active', respondentUserId = USER, offerable = true } = opts;
  return {
    session: { id: 'sess-1', status, versionId: 'v1', respondentUserId },
    base: {
      sessionId: 'sess-1',
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        // offerable: zero thresholds → 'offer'; otherwise demand full coverage we don't have.
        coverageThreshold: offerable ? 0 : 1,
        minQuestionsAnswered: 0,
        maxQuestionsPerSession: null,
        costBudgetUsd: null,
      },
      questions: [
        {
          id: 'q1',
          key: 'role',
          sectionId: 's1',
          sectionOrdinal: 0,
          ordinal: 0,
          weight: 1,
          required: false,
          type: 'free_text' as const,
          tagIds: [],
          prompt: 'What is your role?',
        },
      ],
      answered: offerable ? [{ questionId: 'q1', confidence: 0.9 }] : [],
      existingAnswers: [],
      recentMessages: [],
      selectionRound: 1,
    },
    slots: [],
    activeQuestionKey: null,
    byId: new Map(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  ctxMock.buildTurnContext.mockResolvedValue(loadedContext());
  sessionsMock.markSessionCompleted.mockResolvedValue('completed');
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(ctxMock.buildTurnContext).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist (before access)', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(sessionsMock.markSessionCompleted).not.toHaveBeenCalled();
  });

  it('403s for another respondent', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ respondentUserId: 'someone-else' }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });
});

describe('anonymous access (submit allowed for both kinds)', () => {
  it('200s a valid anonymous caller in an offer state', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ respondentUserId: null }));
    const res = await POST(req({ 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
    expect(sessionsMock.markSessionCompleted).toHaveBeenCalledWith('sess-1', {
      reason: 'respondent_submit',
    });
  });
});

describe('status gate', () => {
  it('idempotently 200s an already-completed session without re-transitioning', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ status: 'completed' }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
    expect(body.data.sessionId).toBe('sess-1');
    expect(sessionsMock.markSessionCompleted).not.toHaveBeenCalled();
  });

  it('409s a paused session (must resume before submitting)', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ status: 'paused' }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SESSION_NOT_ACTIVE');
    expect(sessionsMock.markSessionCompleted).not.toHaveBeenCalled();
  });
});

describe('eligibility', () => {
  it('200s and completes when the session is in an offer state', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
  });

  it('409s SUBMIT_NOT_READY when thresholds are unmet', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ offerable: false }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SUBMIT_NOT_READY');
    expect(sessionsMock.markSessionCompleted).not.toHaveBeenCalled();
  });
});

describe('transition race', () => {
  it('409s if the completion transition is rejected by the state machine', async () => {
    sessionsMock.markSessionCompleted.mockRejectedValue(
      new SessionTransitionError('paused', 'completed')
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
  });
});
