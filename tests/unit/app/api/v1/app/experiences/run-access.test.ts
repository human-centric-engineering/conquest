/**
 * canReadRun (P15.3) — who may read an experience run.
 *
 * The shared gate behind both the poll and the stitched-transcript route. The transcript route is
 * the sensitive one: it returns whole prior-leg conversations, which can contain raw safeguarding
 * disclosures. These tests pin the rules that keep that closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

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

import { canReadRun } from '@/app/api/v1/app/experiences/_lib/run-access';
import { mintRunToken } from '@/app/api/v1/app/experiences/_lib/run-access-token';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

const RUN_ID = 'run_1';
const LEG_A = 'sess_a';
const LEG_B = 'sess_b';

/** A request carrying the given cookies and headers. */
function req(opts: { cookies?: Record<string, string>; token?: string } = {}): NextRequest {
  const cookieEntries = Object.entries(opts.cookies ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
  return {
    cookies: { getAll: () => cookieEntries },
    headers: new Headers(opts.token ? { 'x-session-token': opts.token } : {}),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getServerSession.mockResolvedValue(null);
  // Newest-first, matching the route's orderBy.
  prismaMock.prisma.appExperienceRunLeg.findMany.mockResolvedValue([
    { sessionId: LEG_B },
    { sessionId: LEG_A },
  ]);
  prismaMock.prisma.appQuestionnaireSession.findFirst.mockResolvedValue(null);
});

describe('canReadRun — run cookie', () => {
  it('admits a valid run credential and points at the NEWEST leg', async () => {
    const { token } = mintRunToken(RUN_ID);
    const access = await canReadRun(req({ cookies: { cq_run_7F3K9M2P: token } }), RUN_ID);

    expect(access.allowed).toBe(true);
    expect(access.viaRunCookie).toBe(true);
    // A run-scoped credential says nothing about which leg the holder is on; the newest is where
    // the journey actually is.
    expect(access.knownSessionId).toBe(LEG_B);
  });

  it('refuses a credential minted for a DIFFERENT run', async () => {
    const { token } = mintRunToken('run_someone_else');
    const access = await canReadRun(req({ cookies: { cq_run_7F3K9M2P: token } }), RUN_ID);
    expect(access.allowed).toBe(false);
  });

  it('ignores the cookie NAME and trusts only the signed payload', async () => {
    // The name is attacker-controlled. A cookie named for THIS run carrying another run's token
    // must not open it — only the payload decides.
    const { token } = mintRunToken('run_someone_else');
    const access = await canReadRun(req({ cookies: { cq_run_ANYTHING: token } }), RUN_ID);
    expect(access.allowed).toBe(false);
  });

  it('finds the matching credential among several concurrent journeys', async () => {
    const other = mintRunToken('run_other').token;
    const mine = mintRunToken(RUN_ID).token;
    const access = await canReadRun(
      req({ cookies: { cq_run_AAAA1111: other, cq_run_BBBB2222: mine } }),
      RUN_ID
    );
    expect(access.allowed).toBe(true);
  });

  it('ignores non-run cookies entirely', async () => {
    const access = await canReadRun(
      req({ cookies: { session: 'irrelevant', theme: 'dark' } }),
      RUN_ID
    );
    expect(access.allowed).toBe(false);
  });

  it('refuses a garbage cookie value without throwing', async () => {
    const call = canReadRun(req({ cookies: { cq_run_7F3K9M2P: 'not-a-token' } }), RUN_ID);
    await expect(call).resolves.toEqual({ allowed: false });
  });
});

describe('canReadRun — session token', () => {
  it('admits a token for any leg of the run and reports which', async () => {
    const { token } = mintSessionToken(LEG_A);
    const access = await canReadRun(req({ token }), RUN_ID);

    expect(access.allowed).toBe(true);
    expect(access.viaToken).toBe(true);
    expect(access.knownSessionId).toBe(LEG_A);
  });

  it('refuses a token for a session outside this run', async () => {
    const { token } = mintSessionToken('sess_unrelated');
    expect((await canReadRun(req({ token }), RUN_ID)).allowed).toBe(false);
  });
});

describe('canReadRun — authenticated', () => {
  it('admits a respondent who owns one of the run’s sessions', async () => {
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'user' } });
    prismaMock.prisma.appQuestionnaireSession.findFirst.mockResolvedValue({ id: LEG_A });

    const access = await canReadRun(req(), RUN_ID);
    expect(access.allowed).toBe(true);
    expect(access.knownSessionId).toBe(LEG_A);
    // No minted credential for a cookie-authenticated respondent — they do not need one.
    expect(access.viaToken).toBeUndefined();
    expect(access.viaRunCookie).toBeUndefined();
  });

  it('refuses a signed-in user who owns none of them', async () => {
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_2', role: 'user' } });
    expect((await canReadRun(req(), RUN_ID)).allowed).toBe(false);
  });

  it('flags the admin bypass distinctly, so the transcript route can exclude it', async () => {
    authMock.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'admin' } });

    const access = await canReadRun(req(), RUN_ID);
    expect(access.allowed).toBe(true);
    // `isAdmin` is what the transcript route refuses on. An admin may poll a run's state, but
    // reading a respondent's conversation belongs on the audited admin session viewer, not here.
    expect(access.isAdmin).toBe(true);
    expect(access.knownSessionId).toBeUndefined();
  });
});

describe('canReadRun — no legs', () => {
  it('refuses a run with no legs even with a valid credential', async () => {
    prismaMock.prisma.appExperienceRunLeg.findMany.mockResolvedValue([]);
    const { token } = mintRunToken(RUN_ID);
    const access = await canReadRun(req({ cookies: { cq_run_7F3K9M2P: token } }), RUN_ID);
    expect(access.allowed).toBe(false);
  });
});
