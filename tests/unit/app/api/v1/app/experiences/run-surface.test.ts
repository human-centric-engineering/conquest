/**
 * resolveRunSurface (P15.3) — what `/x/<publicRef>` resolves to, and for whom.
 *
 * The central rule under test: the public ref ADDRESSES a journey but never AUTHORISES it. It is
 * an eight-character human-quotable support code, so anything that treats it as a credential is a
 * hole. Authorisation comes from the httpOnly run cookie or from owning the leg.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: 'test-secret-value-for-hmac' } }));

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appExperienceRun: { findUnique: vi.fn() },
    appQuestionnaireSession: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

const authMock = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth/utils', () => authMock);

import { resolveRunSurface } from '@/app/api/v1/app/experiences/_lib/run-surface';
import { mintRunToken } from '@/app/api/v1/app/experiences/_lib/run-access-token';

const REF = '7F3K9M2P';
const RUN_ID = 'run_1';
const SESSION_ID = 'sess_current';

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getServerSession.mockResolvedValue(null);
  prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
    id: RUN_ID,
    publicRef: REF,
    status: 'active',
    // Newest-first (take: 1) — the leg the journey is actually on.
    legs: [{ sessionId: SESSION_ID }],
  });
  prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
    id: SESSION_ID,
    versionId: 'ver_1',
    respondentUserId: null,
  });
});

describe('resolveRunSurface — the ref is not a credential', () => {
  it('refuses a bare ref with no cookie and no session', async () => {
    const result = await resolveRunSurface(REF, []);
    // The whole point: knowing the ref must not be enough.
    expect(result).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('refuses a run credential minted for a DIFFERENT run at this address', async () => {
    const { token } = mintRunToken('run_someone_else');
    const result = await resolveRunSurface(REF, [token]);
    expect(result).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('refuses a garbage cookie value without throwing', async () => {
    await expect(resolveRunSurface(REF, ['not-a-token'])).resolves.toEqual({
      ok: false,
      reason: 'no_credential',
    });
  });
});

describe('resolveRunSurface — the run cookie', () => {
  it('opens the newest leg and mints a session token for it', async () => {
    const { token } = mintRunToken(RUN_ID);
    const result = await resolveRunSurface(REF, [token]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.versionId).toBe('ver_1');
    expect(result.runId).toBe(RUN_ID);
    // The workspace still drives per-turn API calls with a session token, minted fresh per render.
    expect(result.sessionToken).toBeTruthy();
  });

  it('finds the right credential among several concurrent journeys', async () => {
    const others = [mintRunToken('run_a').token, mintRunToken('run_b').token];
    const mine = mintRunToken(RUN_ID).token;
    const result = await resolveRunSurface(REF, [...others, mine]);
    expect(result.ok).toBe(true);
  });
});

describe('resolveRunSurface — authenticated respondent', () => {
  it('opens the leg they own, with no minted token', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      versionId: 'ver_1',
      respondentUserId: 'user_1',
    });
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'user' } });

    const result = await resolveRunSurface(REF, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Their own cookie already opens the session; issuing a second credential buys nothing.
    expect(result.sessionToken).toBeNull();
  });

  it('refuses a signed-in user who does not own the leg', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      versionId: 'ver_1',
      respondentUserId: 'user_1',
    });
    authMock.getServerSession.mockResolvedValue({ user: { id: 'user_2', role: 'user' } });

    expect(await resolveRunSurface(REF, [])).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('gives an ADMIN no bypass — this surface is not the audited viewer', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      versionId: 'ver_1',
      respondentUserId: 'user_1',
    });
    authMock.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });

    expect(await resolveRunSurface(REF, [])).toEqual({ ok: false, reason: 'no_credential' });
  });
});

describe('resolveRunSurface — dead addresses', () => {
  it('reports not_found for an unknown ref', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue(null);
    expect(await resolveRunSurface('NOPE0000', [])).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports not_found for a run with no legs, WITHOUT checking credentials', async () => {
    prismaMock.prisma.appExperienceRun.findUnique.mockResolvedValue({
      id: RUN_ID,
      publicRef: REF,
      status: 'active',
      legs: [],
    });
    const { token } = mintRunToken(RUN_ID);
    // Same answer whether or not the caller holds a valid credential — a legless run is a dead
    // address, and distinguishing it would confirm the ref exists.
    expect(await resolveRunSurface(REF, [token])).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports not_found when the leg’s session has been erased (UG-1 dangling pointer)', async () => {
    prismaMock.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const { token } = mintRunToken(RUN_ID);
    expect(await resolveRunSurface(REF, [token])).toEqual({ ok: false, reason: 'not_found' });
  });
});
