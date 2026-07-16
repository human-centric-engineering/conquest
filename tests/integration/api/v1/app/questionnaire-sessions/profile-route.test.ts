/**
 * Integration test: respondent profile capture read/write route (F-capture).
 *
 * Pins the route wiring: gate order (live-sessions flag → load → access), both respondent access
 * modes (authenticated owner / anonymous session token), the anonymous / not-applicable guard, the
 * active-status gate, and that PUT re-validates AUTHORITATIVELY server-side (against the stored
 * fields, not the client's) and upserts the normalised values. The resolver, validator, and snapshot
 * writer are mocked, but the REAL `resolveTurnAccess` runs (only the HMAC token verify is stubbed),
 * so 401/403/404 reflect real access logic.
 *
 * @see app/api/v1/app/questionnaire-sessions/[id]/profile/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const dbMock = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: dbMock.findUnique } },
}));

const captureMock = vi.hoisted(() => ({ resolveSessionCapture: vi.fn() }));
vi.mock('@/lib/app/questionnaire/profile/resolve-capture', () => captureMock);

const validateMock = vi.hoisted(() => ({ validateProfileSubmission: vi.fn() }));
vi.mock('@/lib/app/questionnaire/profile/validate-profile-fields', () => validateMock);

const snapshotMock = vi.hoisted(() => ({ upsertProfileSnapshot: vi.fn() }));
vi.mock('@/lib/app/questionnaire/profile/profile-snapshot', () => snapshotMock);

// The profile-capture sub-cap; default to allowing, flipped in the rate-limit test.
const limiterMock = vi.hoisted(() => ({
  check: vi.fn((): { success: boolean; limit: number; remaining: number; reset: number } => ({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  })),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => ({
  profileCaptureLimiter: limiterMock,
}));

// Real resolveTurnAccess runs; stub only the token verify.
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { GET, PUT } from '@/app/api/v1/app/questionnaire-sessions/[id]/profile/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG } from '@/lib/app/questionnaire/constants';
import { mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/profile';

function req(opts: { headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  return {
    url: URL,
    headers: new Headers(opts.headers ?? {}),
    json: () => Promise.resolve(opts.body ?? {}),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const FIELDS = [
  {
    key: 'name',
    label: 'Name',
    type: 'text' as const,
    required: true,
    validation: 'hybrid' as const,
  },
];
const CAPTURE = { captureMode: 'form' as const, formFields: FIELDS, satisfied: false };

function session(over: Record<string, unknown> = {}) {
  return { id: 'sess-1', respondentUserId: USER, status: 'active', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAuthenticatedUser());
  dbMock.findUnique.mockResolvedValue(session());
  captureMock.resolveSessionCapture.mockResolvedValue(CAPTURE);
  validateMock.validateProfileSubmission.mockResolvedValue({
    ok: true,
    values: { name: 'Ada Lovelace' },
  });
  snapshotMock.upsertProfileSnapshot.mockResolvedValue(undefined);
  limiterMock.check.mockReturnValue({ success: true, limit: 20, remaining: 19, reset: 0 });
  // Default the token verify (clearAllMocks wipes it, and its implementation otherwise persists across
  // tests) so the no-login tests below start from a valid-token baseline.
  tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
});

describe('GET — capture config read', () => {
  it('404s when the live-sessions flag is off, before load', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation(async (f) =>
      f === APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG ? false : true
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.findUnique).not.toHaveBeenCalled();
  });

  it('returns the resolved capture to the owner', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { capture: unknown } };
    expect(body.data.capture).toEqual(CAPTURE);
  });

  it('403s an authenticated user who does not own the session', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: 'someone-else' }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('returns capture: null for an anonymous version', async () => {
    captureMock.resolveSessionCapture.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    const body = (await res.json()) as { data: { capture: unknown } };
    expect(body.data.capture).toBeNull();
  });

  it('401s an anonymous session with no token', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('404s when the session does not exist (before access/resolve)', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(captureMock.resolveSessionCapture).not.toHaveBeenCalled();
  });
});

describe('PUT — capture submit', () => {
  it('validates and upserts the NORMALISED values on success', async () => {
    const res = await PUT(req({ body: { profileValues: { name: 'ada   lovelace' } } }), ctx);
    expect(res.status).toBe(200);
    // Server re-derives fields from the stored config — validates the STORED fields, not the client's.
    expect(validateMock.validateProfileSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ fields: FIELDS, sessionId: 'sess-1' })
    );
    // Persists the validator's normalised values, keyed to the owner for the GDPR cascade.
    expect(snapshotMock.upsertProfileSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      USER,
      { name: 'Ada Lovelace' }
    );
  });

  it('returns 400 INVALID_PROFILE with fieldErrors and does NOT persist', async () => {
    validateMock.validateProfileSubmission.mockResolvedValue({
      ok: false,
      fieldErrors: { name: 'Looks like placeholder text' },
      message: 'Some details need a quick fix.',
    });
    const res = await PUT(req({ body: { profileValues: { name: 'asdf' } } }), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { fieldErrors: unknown } };
    };
    expect(body.error.code).toBe('INVALID_PROFILE');
    expect(body.error.details?.fieldErrors).toEqual({ name: 'Looks like placeholder text' });
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('409s CAPTURE_NOT_APPLICABLE for an anonymous version and never validates', async () => {
    captureMock.resolveSessionCapture.mockResolvedValue(null);
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CAPTURE_NOT_APPLICABLE');
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('409s CAPTURE_NOT_APPLICABLE when there is no form subset (all-conversational version)', async () => {
    // A conversational default with no form-placement fields resolves to an empty formFields subset —
    // the PUT (which only handles the form gate) is not applicable.
    captureMock.resolveSessionCapture.mockResolvedValue({
      captureMode: 'conversational' as const,
      formFields: [],
      satisfied: true,
    });
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CAPTURE_NOT_APPLICABLE');
  });

  it('409s SESSION_NOT_ACTIVE for a terminal session', async () => {
    dbMock.findUnique.mockResolvedValue(session({ status: 'completed' }));
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('persists a null respondentUserId for a non-anonymous no-login respondent', async () => {
    // No-login session (respondentUserId null) on a NON-anonymous version (resolver returned CAPTURE).
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    const res = await PUT(
      req({ headers: { 'x-session-token': 'tok' }, body: { profileValues: { name: 'Ada' } } }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(snapshotMock.upsertProfileSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      null,
      { name: 'Ada Lovelace' }
    );
  });

  it('401s an anonymous submit with no token (never validates)', async () => {
    dbMock.findUnique.mockResolvedValue(session({ respondentUserId: null }));
    setAuth(null);
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(401);
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist (before access/validate)', async () => {
    dbMock.findUnique.mockResolvedValue(null);
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(404);
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
  });

  it('400s VALIDATION_ERROR for a malformed body (missing profileValues)', async () => {
    const res = await PUT(req({ body: { wrong: 'shape' } }), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });

  it('429s when the profile-capture sub-cap is exceeded (never spends the LLM)', async () => {
    limiterMock.check.mockReturnValue({ success: false, limit: 20, remaining: 0, reset: 0 });
    const res = await PUT(req({ body: { profileValues: { name: 'Ada' } } }), ctx);
    expect(res.status).toBe(429);
    // The agentic validation pass is never reached — the point of the cap.
    expect(validateMock.validateProfileSubmission).not.toHaveBeenCalled();
    expect(snapshotMock.upsertProfileSnapshot).not.toHaveBeenCalled();
  });
});
