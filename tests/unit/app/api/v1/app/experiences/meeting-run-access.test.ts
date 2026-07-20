/**
 * The meeting routes must not treat `runId` as a credential (P15.5).
 *
 * Files under test:
 *   app/api/v1/app/experiences/meetings/[meetingId]/participant/route.ts
 *   app/api/v1/app/experiences/meetings/[meetingId]/rooms/route.ts
 *
 * Both routes take a `runId` from the caller — one from the query string, one from the body — and
 * both mint a SESSION TOKEN for the run's breakout leg. `runId` is a plain cuid that travels in
 * that query string, in access logs, and in the `/join` response body, so it is not a secret. Left
 * ungated, quoting a stranger's run id was enough to be handed a signed credential for their
 * breakout session, and on `/rooms` to move them into a different room as well.
 *
 * `canReadRun` runs for REAL here — only Prisma and the meeting service are mocked. A test that
 * stubbed the gate could not tell a closed hole from an open one, since the whole bug was that the
 * gate was never called. The tests therefore assert both halves of the refusal: the status code,
 * and that no session token came back and the service was never reached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: 'test-secret-value-for-hmac' } }));

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRunLeg: { findMany: vi.fn() },
    appQuestionnaireSession: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const authMock = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth/utils', () => authMock);

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/app/api/v1/app/experiences/_lib/rate-limit', () => ({
  runPollLimiter: { check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })) },
  experienceStartLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
}));

const serviceMock = vi.hoisted(() => ({
  participantState: vi.fn(),
  chooseRoom: vi.fn(),
  loadBreakoutRooms: vi.fn(),
  joinMeeting: vi.fn(),
}));
vi.mock('@/app/api/v1/app/experiences/_lib/meeting-service', () => serviceMock);

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { GET: participantGET } =
  (await import('@/app/api/v1/app/experiences/meetings/[meetingId]/participant/route')) as {
    GET: AnyRouteHandler;
  };
const { POST: roomsPOST } =
  (await import('@/app/api/v1/app/experiences/meetings/[meetingId]/rooms/route')) as {
    POST: AnyRouteHandler;
  };

const { POST: joinPOST } =
  (await import('@/app/api/v1/app/experiences/meetings/[meetingId]/join/route')) as {
    POST: AnyRouteHandler;
  };

import { mintRunToken, verifyRunToken } from '@/app/api/v1/app/experiences/_lib/run-access-token';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const MEETING_ID = 'meeting_1';
const RUN_ID = 'run_victim';
const LEG_SESSION = 'sess_breakout';
const ROOM_ID = 'room_1';
const PUBLIC_REF = '7F3K9M2P';

/** The response envelope these routes return. */
interface Envelope {
  success: boolean;
  data?: { sessionId?: string | null; sessionToken?: string };
  error?: { code: string };
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && 'success' in value;
}

async function envelope(response: Response): Promise<Envelope> {
  const parsed: unknown = await response.json();
  // Guarded rather than cast: a response that stopped carrying the standard envelope should fail
  // the test loudly, not slip through as an object with every field undefined.
  if (!isEnvelope(parsed)) throw new Error('response body is not the standard envelope');
  return parsed;
}

const params = Promise.resolve({ meetingId: MEETING_ID });

interface RequestOpts {
  /** Run credentials, as `{ cookieName: token }` — the cookie NAME is attacker-controlled. */
  cookies?: Record<string, string>;
  sessionToken?: string;
  body?: unknown;
}

/**
 * A stub request rather than a real `NextRequest`.
 *
 * jsdom treats `Cookie` as a forbidden header and silently drops it, so a real `NextRequest` built
 * here arrives with no cookies at all — every credential test would pass for the wrong reason. The
 * sibling `run-access.test.ts` stubs the same two members for the same reason.
 */
function req(url: string, opts: RequestOpts = {}): NextRequest {
  const cookieEntries = Object.entries(opts.cookies ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
  return {
    url,
    cookies: { getAll: () => cookieEntries },
    headers: new Headers(opts.sessionToken ? { 'x-session-token': opts.sessionToken } : {}),
    json: () => Promise.resolve(opts.body),
  } as unknown as NextRequest;
}

function participantRequest(opts: RequestOpts = {}): NextRequest {
  return req(
    `http://localhost/api/v1/app/experiences/meetings/${MEETING_ID}/participant?runId=${RUN_ID}`,
    opts
  );
}

function roomsRequest(opts: RequestOpts = {}): NextRequest {
  return req(`http://localhost/api/v1/app/experiences/meetings/${MEETING_ID}/rooms`, {
    ...opts,
    // The body carries the victim's run id — the exact shape of the original attack.
    body: { runId: RUN_ID, roomId: ROOM_ID },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getServerSession.mockResolvedValue(null);
  // The run has one leg — a breakout is running, which is when a session token is mintable and so
  // when the hole was worth the most.
  prismaMock.prisma.appExperienceRunLeg.findMany.mockResolvedValue([{ sessionId: LEG_SESSION }]);
  prismaMock.prisma.appQuestionnaireSession.findFirst.mockResolvedValue(null);

  serviceMock.participantState.mockResolvedValue({
    sessionId: LEG_SESSION,
    window: { canAnswer: true, canSubmit: true, reason: 'open' },
  });
  serviceMock.chooseRoom.mockResolvedValue({ ok: true, sessionId: LEG_SESSION });
  // The common join: nobody has started a breakout, so there is no session yet.
  serviceMock.joinMeeting.mockResolvedValue({
    runId: RUN_ID,
    publicRef: PUBLIC_REF,
    sessionId: null,
    meetingId: MEETING_ID,
  });
});

describe('POST /join — where the credential comes from', () => {
  /** The `Set-Cookie` header carrying a run credential, if the response issued one. */
  function runCookie(response: Response): string | undefined {
    return response.headers
      .getSetCookie()
      .find((header) => header.startsWith(`cq_run_${PUBLIC_REF}=`));
  }

  it('issues a run credential the gated routes will accept', async () => {
    const response = await joinPOST(req('http://localhost/join', { body: {} }), { params });

    expect(response.status).toBe(201);
    const header = runCookie(response);
    expect(header).toBeDefined();
    // The whole point of the join half of the fix: the token in that cookie must verify to THIS
    // run, since that is the only thing `canReadRun` will accept.
    const token = header?.slice(`cq_run_${PUBLIC_REF}=`.length).split(';')[0] ?? '';
    expect(verifyRunToken(token)).toEqual({ ok: true, runId: RUN_ID });
  });

  it('keeps it out of reach of script and off other sites’ POSTs', async () => {
    const response = await joinPOST(req('http://localhost/join', { body: {} }), { params });
    expect(runCookie(response)).toContain('HttpOnly');
    expect(runCookie(response)).toContain('SameSite=Lax');
  });

  it('issues it to an AUTHENTICATED participant too', async () => {
    // Unlike `/x`, where the respondent's own auth cookie suffices. A meeting run has no legs until
    // the first breakout, so there is nothing for `canReadRun` to match a signed-in caller against
    // — without this cookie their very first poll would 404.
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'USER' } });

    const response = await joinPOST(req('http://localhost/join', { body: {} }), { params });

    expect(response.status).toBe(201);
    expect(runCookie(response)).toBeDefined();
  });
});

describe('GET /participant — runId alone must not open a stranger’s run', () => {
  it('refuses an anonymous caller holding only the victim’s runId', async () => {
    const response = await participantGET(participantRequest(), { params });

    expect(response.status).toBe(404);
    const body = await envelope(response);
    expect(body.success).toBe(false);
    // The payload of the bug: a signed session token for someone else's breakout.
    expect(body.data?.sessionToken).toBeUndefined();
    // Gated BEFORE the service, so an unproven caller cannot even provoke the lazy session mint.
    expect(serviceMock.participantState).not.toHaveBeenCalled();
  });

  it('answers 404, not 403 — holding a run id must not confirm it exists', async () => {
    const response = await participantGET(participantRequest(), { params });
    expect(response.status).toBe(404);
    expect((await envelope(response)).error?.code).toBe('NOT_FOUND');
  });

  it('refuses a run credential minted for a DIFFERENT run', async () => {
    const { token } = mintRunToken('run_someone_else');
    const response = await participantGET(
      participantRequest({ cookies: { cq_run_7F3K9M2P: token } }),
      { params }
    );

    expect(response.status).toBe(404);
    expect(serviceMock.participantState).not.toHaveBeenCalled();
  });

  it('refuses a session token signed for a session outside this run', async () => {
    const { token } = mintSessionToken('sess_not_in_this_run');
    const response = await participantGET(participantRequest({ sessionToken: token }), { params });

    expect(response.status).toBe(404);
    expect(serviceMock.participantState).not.toHaveBeenCalled();
  });

  it('admits the holder of this run’s credential and mints their session token', async () => {
    const { token } = mintRunToken(RUN_ID);
    const response = await participantGET(
      participantRequest({ cookies: { cq_run_7F3K9M2P: token } }),
      { params }
    );

    expect(response.status).toBe(200);
    const body = await envelope(response);
    expect(body.data?.sessionId).toBe(LEG_SESSION);
    expect(typeof body.data?.sessionToken).toBe('string');
    expect(serviceMock.participantState).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      runId: RUN_ID,
    });
  });

  it('admits a session token for a leg of this run', async () => {
    const { token } = mintSessionToken(LEG_SESSION);
    const response = await participantGET(participantRequest({ sessionToken: token }), { params });

    expect(response.status).toBe(200);
    expect((await envelope(response)).data?.sessionId).toBe(LEG_SESSION);
  });

  it('admits a participant whose run has NO legs yet — the join-before-breakout case', async () => {
    // The constraint the fix had to respect: people join during the introduction, so the run is
    // legless until the facilitator starts a breakout. The cookie is the only proof that exists.
    prismaMock.prisma.appExperienceRunLeg.findMany.mockResolvedValue([]);
    serviceMock.participantState.mockResolvedValue({
      sessionId: null,
      window: { canAnswer: false, canSubmit: false, reason: 'not_started' },
    });

    const { token } = mintRunToken(RUN_ID);
    const response = await participantGET(
      participantRequest({ cookies: { cq_run_7F3K9M2P: token } }),
      { params }
    );

    expect(response.status).toBe(200);
    const body = await envelope(response);
    expect(body.data?.sessionId).toBeNull();
    // Nothing to hold a token for yet, and none is invented.
    expect(body.data?.sessionToken).toBeUndefined();
  });
});

describe('POST /rooms — runId alone must not move a stranger or open their session', () => {
  it('refuses an anonymous caller holding only the victim’s runId', async () => {
    const response = await roomsPOST(roomsRequest(), { params });

    expect(response.status).toBe(404);
    const body = await envelope(response);
    expect(body.data?.sessionToken).toBeUndefined();
    // The second half of this hole: an ungated call also RELOCATED the victim.
    expect(serviceMock.chooseRoom).not.toHaveBeenCalled();
  });

  it('refuses a run credential minted for a DIFFERENT run', async () => {
    const { token } = mintRunToken('run_someone_else');
    const response = await roomsPOST(roomsRequest({ cookies: { cq_run_7F3K9M2P: token } }), {
      params,
    });

    expect(response.status).toBe(404);
    expect(serviceMock.chooseRoom).not.toHaveBeenCalled();
  });

  it('admits the holder of this run’s credential and mints their session token', async () => {
    const { token } = mintRunToken(RUN_ID);
    const response = await roomsPOST(roomsRequest({ cookies: { cq_run_7F3K9M2P: token } }), {
      params,
    });

    expect(response.status).toBe(200);
    const body = await envelope(response);
    expect(body.data?.sessionId).toBe(LEG_SESSION);
    expect(typeof body.data?.sessionToken).toBe('string');
    expect(serviceMock.chooseRoom).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      runId: RUN_ID,
      roomId: ROOM_ID,
    });
  });

  it('admits a session token for a leg of this run', async () => {
    const { token } = mintSessionToken(LEG_SESSION);
    const response = await roomsPOST(roomsRequest({ sessionToken: token }), { params });

    expect(response.status).toBe(200);
    expect(serviceMock.chooseRoom).toHaveBeenCalledTimes(1);
  });

  it('mints no session token for an authenticated caller who passed the gate', async () => {
    // Signed-in respondents drive their turns with their own auth cookie; handing them a second
    // credential would widen the surface for nothing.
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'user' } });
    prismaMock.prisma.appQuestionnaireSession.findFirst.mockResolvedValue({ id: LEG_SESSION });

    const response = await roomsPOST(roomsRequest(), { params });

    expect(response.status).toBe(200);
    expect((await envelope(response)).data?.sessionToken).toBeUndefined();
  });
});
