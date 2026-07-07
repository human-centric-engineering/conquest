/**
 * Integration test: selectable interviewer persona routes (GET menu / PATCH choice).
 *
 * Pins the route wiring: gate order (live-sessions flag → load → access → persona flag), both
 * respondent access modes (authenticated owner / anonymous session token), the GET platform-flag-off
 * short-circuit (returns `persona: null` without resolving), the PATCH flag-off 404, and that a chosen
 * key is validated against the resolved library before it's persisted. The resolver
 * (`resolveSessionPersonas`) and session lookup/update are mocked, but the REAL `resolveTurnAccess`
 * runs (only the HMAC token verify is stubbed), so 401/403/404 reflect real access logic.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/persona/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const dbMock = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: dbMock.findUnique, update: dbMock.update },
  },
}));

const personaMock = vi.hoisted(() => ({ resolveSessionPersonas: vi.fn() }));
vi.mock('@/lib/app/questionnaire/persona/resolve', () => personaMock);

// Real resolveTurnAccess runs; stub only the token verify.
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET, PATCH } from '@/app/api/v1/app/questionnaire-sessions/[id]/persona/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
  APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG,
} from '@/lib/app/questionnaire/constants';
import { mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/persona';

function req(method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    url: URL,
    method,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const MENU = {
  enabled: true,
  personas: [
    { key: 'neutral-coach', label: 'The Coach', description: 'Balanced.' },
    { key: 'comedian', label: 'The Comedian', description: 'Playful.' },
  ],
  selectedPersonaKey: null,
  defaultPersonaKey: 'neutral-coach',
};

function session(over: Record<string, unknown> = {}) {
  return { id: 'sess-1', respondentUserId: USER, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  dbMock.findUnique.mockResolvedValue(session());
  dbMock.update.mockResolvedValue(session());
  personaMock.resolveSessionPersonas.mockResolvedValue(MENU);
});

describe('GET — gate order', () => {
  it('404s when the live-sessions flag is off, before load or resolve', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation(async (f) =>
      f === APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG ? false : true
    );
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.findUnique).not.toHaveBeenCalled();
    expect(personaMock.resolveSessionPersonas).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(404);
    expect(personaMock.resolveSessionPersonas).not.toHaveBeenCalled();
  });

  it('returns persona: null without resolving when the persona flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation(async (name: string) =>
      name === APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG ? false : true
    );
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { persona: unknown } };
    expect(body.data.persona).toBeNull();
    expect(personaMock.resolveSessionPersonas).not.toHaveBeenCalled();
  });
});

describe('GET — access', () => {
  it('returns the resolved menu to the owner', async () => {
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { persona: unknown } };
    expect(body.data.persona).toEqual(MENU);
  });

  it('403s an authenticated user who does not own the session', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: 'someone-else' }));
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(403);
  });

  it('returns the menu for a valid anonymous session token', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
    // mockReturnValueOnce so the stubbed "valid token" verdict can't leak into later tests
    // (vi.clearAllMocks() clears call history but not a persisted mockReturnValue).
    tokenMock.verifySessionToken.mockReturnValueOnce({ ok: true, sessionId: 'sess-1' });
    const res = await GET(req('GET', undefined, { 'x-session-token': 'tok' }), ctx);
    expect(res.status).toBe(200);
  });

  it('401s an unauthenticated request on an owned session, before resolving', async () => {
    setAuth(null);
    const res = await GET(req('GET'), ctx);
    expect(res.status).toBe(401);
    expect(personaMock.resolveSessionPersonas).not.toHaveBeenCalled();
  });

  it('401s an anonymous session when the session token is invalid', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
    tokenMock.verifySessionToken.mockReturnValueOnce({ ok: false, reason: 'bad_signature' });
    const res = await GET(req('GET', undefined, { 'x-session-token': 'bad' }), ctx);
    expect(res.status).toBe(401);
    expect(personaMock.resolveSessionPersonas).not.toHaveBeenCalled();
  });
});

describe('PATCH — set the chosen persona', () => {
  it('persists a known persona key and echoes it', async () => {
    const res = await PATCH(req('PATCH', { personaKey: 'comedian' }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { selectedPersonaKey: string | null } };
    expect(body.data.selectedPersonaKey).toBe('comedian');
    expect(dbMock.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { selectedPersonaKey: 'comedian' },
    });
  });

  it('clears the choice on a null key', async () => {
    const res = await PATCH(req('PATCH', { personaKey: null }), ctx);
    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { selectedPersonaKey: null },
    });
  });

  it('422s an unknown persona key without writing', async () => {
    const res = await PATCH(req('PATCH', { personaKey: 'ghost' }), ctx);
    expect(res.status).toBe(422);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('422s when respondent switching is disabled, without writing', async () => {
    // The pinned persona governs, but there's no picker — a crafted PATCH can't override it.
    personaMock.resolveSessionPersonas.mockResolvedValue({ ...MENU, enabled: false });
    const res = await PATCH(req('PATCH', { personaKey: 'comedian' }), ctx);
    expect(res.status).toBe(422);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('404s when the persona flag is off, before any write', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation(async (name: string) =>
      name === APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG ? false : true
    );
    const res = await PATCH(req('PATCH', { personaKey: 'comedian' }), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('403s a non-owner without writing', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: 'someone-else' }));
    const res = await PATCH(req('PATCH', { personaKey: 'comedian' }), ctx);
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
