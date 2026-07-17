/**
 * Integration test: answer-slot panel read route (F7.2).
 *
 * Pins the route wiring: gate order (flag → load → access), both respondent access
 * modes (authenticated owner / anonymous session token), and that the projected
 * `AnswerPanelView` is returned verbatim. The DB read seam (`loadAnswerPanelState`)
 * is mocked — its pure builder is unit-tested separately — but the REAL
 * `resolveTurnAccess` runs (only the HMAC token verify is stubbed, as in
 * messages-route.test.ts), so 401/403/404 reflect real access logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const panelMock = vi.hoisted(() => ({ loadAnswerPanelState: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel', () => panelMock);

// Real resolveTurnAccess runs; stub only the token verify (session-access-token.test.ts
// covers the HMAC directly).
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/answers/route';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import type { AnswerPanelView } from '@/lib/app/questionnaire/panel/types';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/answers';

function req(headers: Record<string, string> = {}): NextRequest {
  return { url: URL, headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

function view(over: Partial<AnswerPanelView> = {}): AnswerPanelView {
  return {
    status: 'active',
    scope: 'full_progress',
    sections: [
      {
        sectionId: 's1',
        title: 'About you',
        slots: [
          {
            slotKey: 'role',
            prompt: 'What is your role?',
            type: 'free_text',
            typeConfig: null,
            required: true,
            answered: true,
            value: 'Engineer',
            provenance: 'direct',
            confidence: 0.9,
            rationale: 'Stated directly.',
            answeredAtTurnIndex: 1,
            respondentEdited: false,
            refinementHistory: [],
          },
          {
            slotKey: 'team_size',
            prompt: 'How big is your team?',
            type: 'numeric',
            typeConfig: null,
            required: false,
            answered: false,
            value: null,
            provenance: null,
            confidence: null,
            rationale: null,
            answeredAtTurnIndex: null,
            respondentEdited: false,
            refinementHistory: [],
          },
        ],
      },
    ],
    answeredCount: 1,
    totalCount: 2,
    ...over,
  };
}

function loaded(respondentUserId: string | null, panel: AnswerPanelView = view()) {
  return { session: { id: 'sess-1', respondentUserId }, view: panel };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAuthenticatedUser());
  panelMock.loadAnswerPanelState.mockResolvedValue(loaded(USER));
});

describe('gate order', () => {
  it('404s when the session does not exist', async () => {
    panelMock.loadAnswerPanelState.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // Access is not resolved for a missing session.
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('500s via handleAPIError when the load seam throws unexpectedly', async () => {
    panelMock.loadAnswerPanelState.mockRejectedValue(new Error('db unavailable'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe('authenticated access', () => {
  it('200s the projected view for the owning user', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.answeredCount).toBe(1);
    expect(body.data.totalCount).toBe(2);
    expect(body.data.sections[0].slots[0].slotKey).toBe('role');
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('403s when the session belongs to another respondent', async () => {
    panelMock.loadAnswerPanelState.mockResolvedValue(loaded('someone-else'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('anonymous (no-login) access', () => {
  it('200s a valid session-token-bearing anonymous caller', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    panelMock.loadAnswerPanelState.mockResolvedValue(loaded(null));
    const res = await GET(req({ 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
  });

  it('401s an anonymous session with no token', async () => {
    setAuth(mockUnauthenticatedUser());
    panelMock.loadAnswerPanelState.mockResolvedValue(loaded(null));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_TOKEN_REQUIRED');
  });

  it('401s an anonymous session with an invalid/mismatched token', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: false, reason: 'bad_signature' });
    panelMock.loadAnswerPanelState.mockResolvedValue(loaded(null));
    const res = await GET(req({ 'x-session-token': 'bad' }), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_TOKEN_INVALID');
  });
});

describe('scope projection', () => {
  it('returns answered + pending slots in full_progress', async () => {
    const res = await GET(req(), ctx);
    const body = await res.json();
    const slots = body.data.sections[0].slots;
    expect(slots.map((s: { answered: boolean }) => s.answered)).toEqual([true, false]);
  });

  it('passes through an answered_only view (pending slots already omitted by the seam)', async () => {
    panelMock.loadAnswerPanelState.mockResolvedValue(
      loaded(
        USER,
        view({
          scope: 'answered_only',
          sections: [
            {
              sectionId: 's1',
              title: 'About you',
              slots: [
                {
                  slotKey: 'role',
                  prompt: 'What is your role?',
                  type: 'free_text',
                  typeConfig: null,
                  required: true,
                  answered: true,
                  value: 'Engineer',
                  provenance: 'direct',
                  confidence: 0.9,
                  rationale: 'Stated directly.',
                  answeredAtTurnIndex: 1,
                  respondentEdited: false,
                  refinementHistory: [],
                },
              ],
            },
          ],
        })
      )
    );
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body.data.scope).toBe('answered_only');
    expect(body.data.sections[0].slots).toHaveLength(1);
    // totalCount still reflects the whole version (honest "N captured").
    expect(body.data.totalCount).toBe(2);
  });

  it('does not leak authoring internals (weight / tags) in the payload', async () => {
    const res = await GET(req(), ctx);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('weight');
    expect(text).not.toContain('tagIds');
  });
});
