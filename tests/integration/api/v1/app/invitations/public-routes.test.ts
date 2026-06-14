/**
 * Integration test: public respondent invitation routes (F3.2 PR2).
 *
 * Exercises `GET /api/v1/app/invitations/metadata` and `POST …/accept` with the DB
 * seam (`prisma`) and better-auth mocked: flag gate, token resolution (404/410),
 * the sent→opened transition on first view, the already-used guard, the
 * account-exists guard, and the happy-path register → bind → cookie-forward.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { signUpEmail: vi.fn(), signInEmail: vi.fn() } },
}));

vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...real, acceptInviteLimiter: { check: vi.fn(() => ({ success: true })) } };
});

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireInvitation: { findUnique: vi.fn(), update: vi.fn() },
  appQuestionnaireSession: { updateMany: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as metadataGET } from '@/app/api/v1/app/invitations/metadata/route';
import { POST as acceptPOST } from '@/app/api/v1/app/invitations/accept/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';

type Mock = ReturnType<typeof vi.fn>;

const TOKEN = 'plain-token-abc';
const TOKEN_HASH = hashInvitationToken(TOKEN);

function metaReq(token?: string): NextRequest {
  const url = token
    ? `http://localhost:3000/api/v1/app/invitations/metadata?token=${token}`
    : 'http://localhost:3000/api/v1/app/invitations/metadata';
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function acceptReq(body: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/invitations/accept',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}

/** A resolvable invitation row in the resolver's select shape. */
function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'alice@example.com',
    name: 'Alice',
    status: 'sent',
    versionId: 'v1',
    expiresAt: new Date(Date.now() + 7 * 86400_000),
    openedAt: null,
    userId: null,
    version: { questionnaire: { title: 'Customer Satisfaction' } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(invitationRow());
  prismaMock.appQuestionnaireInvitation.update.mockResolvedValue({});
  prismaMock.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.update.mockResolvedValue({});
  (auth.api.signUpEmail as unknown as Mock).mockResolvedValue({ user: { id: 'user-new' } });
  const signInRes = new Response(null, { status: 200 });
  signInRes.headers.append('Set-Cookie', 'session=abc; Path=/; HttpOnly');
  (auth.api.signInEmail as unknown as Mock).mockResolvedValue(signInRes);
});

describe('GET metadata', () => {
  it('404s when the flag is off', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    expect((await metadataGET(metaReq(TOKEN))).status).toBe(404);
  });

  it('400s without a token', async () => {
    expect((await metadataGET(metaReq())).status).toBe(400);
  });

  it('404s for an unknown token', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(null);
    expect((await metadataGET(metaReq('nope'))).status).toBe(404);
  });

  it('410s for an expired invitation', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ expiresAt: new Date(Date.now() - 1000) })
    );
    const res = await metadataGET(metaReq(TOKEN));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false); // full error envelope, not just the code
    expect(body.error.code).toBe('INVITATION_EXPIRED');
  });

  it('410s for a revoked invitation', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'revoked' })
    );
    const res = await metadataGET(metaReq(TOKEN));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITATION_REVOKED');
  });

  it('returns the landing view and marks a sent invitation opened', async () => {
    const res = await metadataGET(metaReq(TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      questionnaireTitle: 'Customer Satisfaction',
      inviteeName: 'Alice',
      status: 'opened',
      expiresAt: expect.any(String), // ISO string — part of the landing-view contract
      accountExists: false, // no user for this email → "set a password" branch
    });
    expect(prismaMock.appQuestionnaireInvitation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: TOKEN_HASH } })
    );
    // First view stamps openedAt (the row's openedAt was null) — pin the conditional write.
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'opened', openedAt: expect.any(Date) }),
      })
    );
  });

  it('does not re-transition an already-opened invitation', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'opened', openedAt: new Date() })
    );
    const res = await metadataGET(metaReq(TOKEN));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('reports accountExists when the invited email already has an account', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-existing' });
    const res = await metadataGET(metaReq(TOKEN));
    expect(res.status).toBe(200);
    expect((await res.json()).data.accountExists).toBe(true);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'alice@example.com' } })
    );
  });
});

describe('POST accept', () => {
  it('registers, binds the invitation, and forwards session cookies', async () => {
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(200);
    expect(auth.api.signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ email: 'alice@example.com' }) })
    );
    // emailVerified set, invitation bound to the new user as registered.
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailVerified: true } })
    );
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-new',
          status: 'registered',
          registeredAt: expect.any(Date),
        }),
      })
    );
    expect(res.headers.getSetCookie().some((c) => c.startsWith('session='))).toBe(true);
  });

  it('accepts an already-opened invitation without re-stamping openedAt', async () => {
    const alreadyOpened = new Date('2026-06-05T00:00:00Z');
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'opened', openedAt: alreadyOpened })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(200);
    const data = prismaMock.appQuestionnaireInvitation.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: 'user-new', status: 'registered' });
    // openedAt was already set — the conditional must NOT overwrite it.
    expect(data).not.toHaveProperty('openedAt');
  });

  it('falls back to the invitation email as the account name when no name is anywhere', async () => {
    // No body.name and an invitation with a null name → the final `?? invitation.email` arm.
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ name: null })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(200);
    expect(auth.api.signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ name: 'alice@example.com' }) })
    );
  });

  it('claims the invitation for an existing account via sign-in (no new account)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-existing' });
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(200);
    // No signup, no emailVerified mutation — we bind to the existing account.
    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    // The supplied password is verified by signInEmail, then bound to the existing id.
    expect(auth.api.signInEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ email: 'alice@example.com' }) })
    );
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-existing', status: 'registered' }),
      })
    );
    expect(res.headers.getSetCookie().some((c) => c.startsWith('session='))).toBe(true);
  });

  it('401s on a wrong password when claiming an existing account, binding nothing', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-existing' });
    (auth.api.signInEmail as unknown as Mock).mockResolvedValue(
      new Response(null, { status: 401 })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'wrongpass1' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    // A bad credential must not bind the invitation.
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
  });

  it('409s when the invitation was already used (registered)', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'registered' })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(409);
    {
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVITATION_ALREADY_USED');
    }
  });

  it('410s for an expired token', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ expiresAt: new Date(Date.now() - 1000) })
    );
    expect((await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }))).status).toBe(
      410
    );
  });

  it('400s on a short password (schema)', async () => {
    expect((await acceptPOST(acceptReq({ token: TOKEN, password: 'short' }))).status).toBe(400);
  });

  it('410s for a revoked token', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'revoked' })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVITATION_REVOKED');
  });

  it('500s when sign-in fails after the account is created, binding nothing', async () => {
    (auth.api.signInEmail as unknown as Mock).mockResolvedValue(
      new Response(null, { status: 401 })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(500);
    // The account was created + verified, but binding now happens *after* sign-in, so a
    // failed auto-login leaves the invitation unbound (not a half-registered state).
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailVerified: true } })
    );
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('429s when the accept rate limit is exceeded, before any work', async () => {
    const { acceptInviteLimiter } = await import('@/lib/security/rate-limit');
    (acceptInviteLimiter.check as unknown as Mock).mockReturnValueOnce({
      success: false,
      remaining: 0,
      reset: 1,
    });
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(429);
    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
  });

  it('maps a racing signup failure to 409 ACCOUNT_EXISTS', async () => {
    (auth.api.signUpEmail as unknown as Mock).mockRejectedValue(new Error('email taken'));
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(409);
    {
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ACCOUNT_EXISTS');
    }
  });

  it('upgrades a frictionless (started, no-account) invite: keeps started + adopts its session', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'started', userId: null })
    );
    prismaMock.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(200);

    // Lifecycle not rewound — stays `started`, just binds the account.
    const updateData = prismaMock.appQuestionnaireInvitation.update.mock.calls[0][0].data;
    expect(updateData.userId).toBe('user-new');
    expect(updateData.status).toBeUndefined();
    // The in-flight no-account session is adopted into the new account.
    expect(prismaMock.appQuestionnaireSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invitationId: 'inv-1', respondentUserId: null },
        data: { respondentUserId: 'user-new' },
      })
    );
  });

  it('rejects an already account-bound invitation (used)', async () => {
    prismaMock.appQuestionnaireInvitation.findUnique.mockResolvedValue(
      invitationRow({ status: 'started', userId: 'someone-else' })
    );
    const res = await acceptPOST(acceptReq({ token: TOKEN, password: 'longenough1' }));
    expect(res.status).toBe(409);
  });
});
