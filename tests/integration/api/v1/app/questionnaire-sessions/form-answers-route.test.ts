/**
 * Integration test: form-mode answer-write route (P-presentation) — PUT …/answers.
 *
 * Pins the route wiring: gate order (flag → load → access → active-status), both
 * respondent access modes, body validation, unknown-key rejection, per-value validation
 * against the question's type/typeConfig (the REAL `validateAnswerValue` runs), and that
 * a valid batch is persisted through the form-answers seam inside one transaction and
 * returns the refreshed form view. The seam itself is unit-tested separately
 * (`form-answers.test.ts`) — here it's mocked to observe the route's orchestration.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/answers/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

// The transaction client passed to the seam is irrelevant (seam is mocked); $transaction
// just invokes the callback with a stub.
const dbMock = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) },
}));
vi.mock('@/lib/db/client', () => dbMock);

const panelMock = vi.hoisted(() => ({ loadAnswerPanelState: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel', () => panelMock);

const seamMock = vi.hoisted(() => ({
  loadSessionForFormWrite: vi.fn(),
  loadVersionSlotsByKey: vi.fn(),
  recordManualAnswer: vi.fn(),
  clearAnswer: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/form-answers', () => seamMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { PUT } from '@/app/api/v1/app/questionnaire-sessions/[id]/answers/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/answers';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    url: URL,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function session(over: Record<string, unknown> = {}) {
  return { id: 'sess-1', status: 'active', respondentUserId: USER, versionId: 'ver-1', ...over };
}

function emptyView(): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [],
    answeredCount: 0,
    totalCount: 0,
  };
}

/** A slot map: `role` is free_text, `score` is a 1–5 likert. */
function slots() {
  return new Map([
    ['role', { id: 'slot-role', key: 'role', type: 'free_text', typeConfig: null }],
    ['score', { id: 'slot-score', key: 'score', type: 'likert', typeConfig: { min: 1, max: 5 } }],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  seamMock.loadSessionForFormWrite.mockResolvedValue(session());
  seamMock.loadVersionSlotsByKey.mockResolvedValue(slots());
  seamMock.recordManualAnswer.mockResolvedValue('created');
  seamMock.clearAnswer.mockResolvedValue(undefined);
  panelMock.loadAnswerPanelState.mockResolvedValue({
    session: { id: 'sess-1', respondentUserId: USER },
    view: emptyView(),
  });
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await PUT(req({ answers: [{ questionKey: 'role', value: 'Eng' }] }), ctx);
    expect(res.status).toBe(404);
    expect(seamMock.loadSessionForFormWrite).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    seamMock.loadSessionForFormWrite.mockResolvedValue(null);
    const res = await PUT(req({ answers: [{ questionKey: 'role', value: 'Eng' }] }), ctx);
    expect(res.status).toBe(404);
  });

  it('409s when the session is not active', async () => {
    seamMock.loadSessionForFormWrite.mockResolvedValue(session({ status: 'completed' }));
    const res = await PUT(req({ answers: [{ questionKey: 'role', value: 'Eng' }] }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(seamMock.recordManualAnswer).not.toHaveBeenCalled();
  });
});

describe('access', () => {
  it('401s an unauthenticated owner session', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await PUT(req({ answers: [{ questionKey: 'role', value: 'Eng' }] }), ctx);
    expect(res.status).toBe(401);
  });

  it('403s when the session belongs to another respondent', async () => {
    seamMock.loadSessionForFormWrite.mockResolvedValue(session({ respondentUserId: 'other' }));
    const res = await PUT(req({ answers: [{ questionKey: 'role', value: 'Eng' }] }), ctx);
    expect(res.status).toBe(403);
  });

  it('200s a valid anonymous/preview session token', async () => {
    setAuth(mockUnauthenticatedUser());
    seamMock.loadSessionForFormWrite.mockResolvedValue(session({ respondentUserId: null }));
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    const res = await PUT(
      req({ answers: [{ questionKey: 'role', value: 'Eng' }] }, { 'x-session-token': 'tok.sig' }),
      ctx
    );
    expect(res.status).toBe(200);
  });
});

describe('validation', () => {
  it('400s an empty answers array', async () => {
    const res = await PUT(req({ answers: [] }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('400s an unknown question key', async () => {
    const res = await PUT(req({ answers: [{ questionKey: 'nope', value: 'x' }] }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('UNKNOWN_QUESTION');
    expect(seamMock.recordManualAnswer).not.toHaveBeenCalled();
  });

  it('400s a likert value outside the scale (real validateAnswerValue)', async () => {
    const res = await PUT(req({ answers: [{ questionKey: 'score', value: 9 }] }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ANSWER_VALUE');
    expect(seamMock.recordManualAnswer).not.toHaveBeenCalled();
  });

  it('rejects the WHOLE batch when one value is invalid (no partial writes)', async () => {
    const res = await PUT(
      req({
        answers: [
          { questionKey: 'role', value: 'Engineer' },
          { questionKey: 'score', value: 99 },
        ],
      }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(seamMock.recordManualAnswer).not.toHaveBeenCalled();
  });
});

describe('persistence', () => {
  it('writes a valid batch through the seam and returns the refreshed form view', async () => {
    seamMock.recordManualAnswer.mockResolvedValueOnce('created').mockResolvedValueOnce('edited');
    const res = await PUT(
      req({
        answers: [
          { questionKey: 'role', value: 'Engineer' },
          { questionKey: 'score', value: 4 },
        ],
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(seamMock.recordManualAnswer).toHaveBeenCalledTimes(2);
    // Normalised likert value (number) reaches the seam.
    expect(seamMock.recordManualAnswer).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      'slot-score',
      4
    );
    // The refreshed view is loaded with forForm = true.
    expect(panelMock.loadAnswerPanelState).toHaveBeenCalledWith('sess-1', false, true);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.scope).toBe('full_progress');
  });

  it('routes a clear to the seam delete path', async () => {
    const res = await PUT(req({ answers: [{ questionKey: 'role', clear: true }] }), ctx);
    expect(res.status).toBe(200);
    expect(seamMock.clearAnswer).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'slot-role');
    expect(seamMock.recordManualAnswer).not.toHaveBeenCalled();
  });
});
