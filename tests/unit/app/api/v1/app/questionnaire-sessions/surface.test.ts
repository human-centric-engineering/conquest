/**
 * GET /api/v1/app/questionnaire-sessions/:id/surface — the session-scoped respondent surface
 * config read that lets a client-booted surface paint a session with its author's configuration.
 *
 * The route itself is thin, so these tests pin the part that is NOT thin: the access gate. The
 * payload describes a specific session's questionnaire — its brand, its vocabulary, its title — so
 * quoting a session id must not be enough to read it. `resolveTurnAccess` (the same gate the turn
 * and transcript routes use: an authenticated owner OR a valid session token) is asserted to run,
 * to run for THIS session, and to be honoured when it refuses.
 *
 * `resolveTurnAccess` and the resolver are mocked at the module boundary — their own behaviour is
 * covered by `resolve-respondent-surface.test.ts` and the turn-access suite.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/surface/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const sessionFindUnique = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: (...a: unknown[]) => sessionFindUnique(...a) },
  },
}));

const resolveTurnAccess = vi.fn();
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-access', () => ({
  resolveTurnAccess: (...a: unknown[]) => resolveTurnAccess(...a),
}));

const resolveRespondentSurfaceConfig = vi.fn();
vi.mock('@/lib/app/questionnaire/session/resolve-respondent-surface', () => ({
  resolveRespondentSurfaceConfig: (...a: unknown[]) => resolveRespondentSurfaceConfig(...a),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() })),
}));

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/surface/route';

const SESSION_ID = 'sess-1';

function request() {
  return new NextRequest(
    `http://localhost/api/v1/app/questionnaire-sessions/${SESSION_ID}/surface`
  );
}

function context() {
  return { params: Promise.resolve({ id: SESSION_ID }) };
}

/** A minimal well-formed bundle — the route passes it through untouched. */
const SURFACE = {
  voiceInputEnabled: true,
  presentationMode: 'chat',
  answerPanelScope: 'hidden',
  theme: { ctaColor: '#123456' },
  glossary: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionFindUnique.mockResolvedValue({ id: SESSION_ID, respondentUserId: 'user-1' });
  resolveTurnAccess.mockResolvedValue({ ok: true });
  resolveRespondentSurfaceConfig.mockResolvedValue(SURFACE);
});

describe('GET /questionnaire-sessions/:id/surface', () => {
  it('returns the resolved bundle for a permitted caller', async () => {
    const res = await GET(request(), context());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.surface).toEqual(SURFACE);
    expect(resolveRespondentSurfaceConfig).toHaveBeenCalledWith(SESSION_ID);
  });

  it('gates on the session the caller asked for, not merely on any session', async () => {
    await GET(request(), context());

    expect(resolveTurnAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: SESSION_ID, respondentUserId: 'user-1' })
    );
  });

  it('refuses a caller the access gate rejects, and does not resolve anything for them', async () => {
    resolveTurnAccess.mockResolvedValue({
      ok: false,
      code: 'FORBIDDEN',
      status: 403,
      message: 'Not your session',
    });

    const res = await GET(request(), context());

    expect(res.status).toBe(403);
    // The refusal must come BEFORE the read — otherwise the payload is built for someone who was
    // never allowed to ask for it, and only the response is withheld.
    expect(resolveRespondentSurfaceConfig).not.toHaveBeenCalled();
  });

  it('404s an unknown session without consulting the access gate', async () => {
    sessionFindUnique.mockResolvedValue(null);

    const res = await GET(request(), context());

    expect(res.status).toBe(404);
    expect(resolveTurnAccess).not.toHaveBeenCalled();
  });

  it('404s rather than 500s when the session vanishes between the two reads', async () => {
    resolveRespondentSurfaceConfig.mockResolvedValue(null);

    const res = await GET(request(), context());

    expect(res.status).toBe(404);
  });
});
