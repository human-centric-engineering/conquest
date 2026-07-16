/**
 * Integration test: live respondent session-create route (F6.1, PR3).
 *
 * Pins the route's orchestration with the create seam + rate limiter mocked: gate order
 * (live-sessions flag → auth → sub-cap → validation), dispatch to the right create fn by
 * body shape, the typed-failure → HTTP mapping, and the created-vs-resumed status codes.
 * The create logic itself is covered in create-session.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const rateMock = vi.hoisted(() => ({ sessionStartLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const createMock = vi.hoisted(() => ({
  createSessionFromInvitation: vi.fn(),
  createSessionForVersion: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => createMock);

// Diagnostics capture (F8.5) — stubbed so the route's best-effort error recording is observable
// without touching the DB. The seam itself is unit-tested in diagnostics/record-error.test.ts.
const diagnosticsMock = vi.hoisted(() => ({ recordQuestionnaireError: vi.fn() }));
vi.mock('@/lib/app/questionnaire/diagnostics', () => diagnosticsMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/route';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function setAuth(sessionVal: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(sessionVal);
}

const OK_SESSION = { id: 'sess-1', status: 'active', versionId: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAuthenticatedUser());
  rateMock.sessionStartLimiter.check.mockReturnValue({ success: true });
  createMock.createSessionFromInvitation.mockResolvedValue({
    ok: true,
    session: OK_SESSION,
    resumed: false,
  });
  createMock.createSessionForVersion.mockResolvedValue({
    ok: true,
    session: OK_SESSION,
    resumed: false,
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(401);
    expect(createMock.createSessionForVersion).not.toHaveBeenCalled();
  });

  it('429s when the session-start sub-cap is exceeded', async () => {
    rateMock.sessionStartLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(429);
    expect(createMock.createSessionForVersion).not.toHaveBeenCalled();
  });

  it('400s on a body that is neither invitationToken nor versionId', async () => {
    const res = await POST(req({ nonsense: true }));
    expect(res.status).toBe(400);
    expect(createMock.createSessionFromInvitation).not.toHaveBeenCalled();
    expect(createMock.createSessionForVersion).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('routes an invitationToken body to createSessionFromInvitation', async () => {
    const res = await POST(req({ invitationToken: 'tok_abcdefghij' }));
    expect(res.status).toBe(201);
    expect(createMock.createSessionFromInvitation).toHaveBeenCalledWith(
      'tok_abcdefghij',
      'cmjbv4i3x00003wsloputgwul',
      undefined // no profileValues on this body
    );
    expect(createMock.createSessionForVersion).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.session).toEqual(OK_SESSION);
    expect(body.meta.resumed).toBe(false);
  });

  it('forwards profileValues from an invitationToken body (F8.3)', async () => {
    const res = await POST(
      req({ invitationToken: 'tok_abcdefghij', profileValues: { team: 'Analytics' } })
    );
    expect(res.status).toBe(201);
    expect(createMock.createSessionFromInvitation).toHaveBeenCalledWith(
      'tok_abcdefghij',
      'cmjbv4i3x00003wsloputgwul',
      { team: 'Analytics' }
    );
  });

  it('routes a versionId body to createSessionForVersion', async () => {
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(201);
    expect(createMock.createSessionForVersion).toHaveBeenCalledWith(
      'v1',
      'cmjbv4i3x00003wsloputgwul'
    );
    expect(createMock.createSessionFromInvitation).not.toHaveBeenCalled();
  });

  it('returns 200 (not 201) when an existing session is resumed', async () => {
    createMock.createSessionForVersion.mockResolvedValue({
      ok: true,
      session: OK_SESSION,
      resumed: true,
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).meta.resumed).toBe(true);
  });
});

describe('typed failure → HTTP mapping', () => {
  it('maps a 403 INVITATION_REQUIRED failure to a 403 error envelope', async () => {
    createMock.createSessionForVersion.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    });
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITATION_REQUIRED');
  });

  it('maps a 404 invitation failure to a 404', async () => {
    createMock.createSessionFromInvitation.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'INVITATION_NOT_FOUND',
      message: 'Invitation not found',
    });
    const res = await POST(req({ invitationToken: 'tok_abcdefghij' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });
});

describe('diagnostics capture (F8.5)', () => {
  it('records an attributable session_create warning on a typed rejection', async () => {
    createMock.createSessionFromInvitation.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'VERSION_NOT_LAUNCHED',
      message: 'This questionnaire is not currently open',
      versionId: 'v-9',
      invitationId: 'inv-1',
    });
    const res = await POST(req({ invitationToken: 'tok_abcdefghij' }));
    expect(res.status).toBe(409);
    expect(diagnosticsMock.recordQuestionnaireError).toHaveBeenCalledTimes(1);
    expect(diagnosticsMock.recordQuestionnaireError.mock.calls[0][0]).toMatchObject({
      versionId: 'v-9',
      invitationId: 'inv-1',
      scope: 'session_create',
      severity: 'warning',
      code: 'VERSION_NOT_LAUNCHED',
    });
  });

  it('records a session_create error and rethrows (→ 500) when create throws', async () => {
    createMock.createSessionForVersion.mockRejectedValue(new Error('db down'));
    const res = await POST(req({ versionId: 'v1' }));
    expect(res.status).toBe(500);
    expect(diagnosticsMock.recordQuestionnaireError).toHaveBeenCalledTimes(1);
    expect(diagnosticsMock.recordQuestionnaireError.mock.calls[0][0]).toMatchObject({
      versionId: 'v1',
      scope: 'session_create',
      stage: 'for_version',
    });
  });
});
