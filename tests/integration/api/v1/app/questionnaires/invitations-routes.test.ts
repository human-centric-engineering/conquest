/**
 * Integration test: questionnaire invitation admin routes (F3.2).
 *
 * Exercises the collection (GET list / POST send), revoke (PATCH), and resend
 * (POST) handlers with the DB seam (`prisma`), the email send, and the rate limiter
 * mocked: gate order (404 flag-off before auth), 401/403, scope-404, the
 * launched-version guard, app-layer dedup, bulk per-recipient results, audit
 * emission, and the revoke/resend transition guards. The Zod contract + token +
 * transition logic are unit-tested separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));

// Mock the email component so we can assert the resolved theme reaches the render —
// `sendInvitationEmail` invokes it directly, so the rendered element's props are the
// <Html> props, not the theme. The mock captures the component's own call args.
vi.mock('@/emails/questionnaire-invitation', () => ({ default: vi.fn(() => null) }));

vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...real, inviteLimiter: { check: vi.fn(() => ({ success: true })) } };
});

const prismaMock = vi.hoisted(() => ({
  appQuestionnaire: { findUnique: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appDemoClient: { findUnique: vi.fn() },
  appQuestionnaireInvitation: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  GET as listGET,
  POST as createPOST,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/route';
import { PATCH as revokePATCH } from '@/app/api/v1/app/questionnaires/[id]/invitations/[invitationId]/route';
import { POST as resendPOST } from '@/app/api/v1/app/questionnaires/[id]/invitations/[invitationId]/resend/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { sendEmail } from '@/lib/email/send';
import QuestionnaireInvitationEmail from '@/emails/questionnaire-invitation';
import { SUNRISE_THEME_DEFAULTS } from '@/lib/app/questionnaire/theming';
import { inviteLimiter } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(
  body?: unknown,
  url = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/invitations'
): NextRequest {
  return { url, headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

/** A persisted invitation row in the INVITATION_SELECT shape. */
function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'alice@example.com',
    name: 'Alice',
    status: 'sent',
    versionId: 'v1',
    // Relative dates so the fixture stays self-evidently "live" regardless of run date.
    expiresAt: new Date(Date.now() + 7 * 86400_000),
    sentAt: new Date(),
    openedAt: null,
    registeredAt: null,
    revokedAt: null,
    createdAt: new Date(),
    version: { versionNumber: 2 },
    ...overrides,
  };
}

/** The shape `loadScopedInvitation` selects (incl. the pinned-version questionnaire title). */
function scopedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    versionId: 'v1',
    email: 'a@x.com',
    name: 'Al',
    status: 'sent',
    demoClientId: null,
    version: { questionnaire: { title: 'Customer Satisfaction' } },
    ...overrides,
  };
}

const COLL = { id: 'qn-1' };
const SINGLE = { id: 'qn-1', invitationId: 'inv-1' };

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  (sendEmail as unknown as Mock).mockResolvedValue({ success: true, status: 'sent', id: 'em-1' });
  // Default: a launched version exists, on a generic (unattributed) questionnaire.
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    versionNumber: 2,
    questionnaire: { title: 'Customer Satisfaction', demoClientId: null },
  });
  prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
  prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(null); // no dedup hit
  prismaMock.appQuestionnaireInvitation.create.mockResolvedValue({ id: 'inv-new' });
  prismaMock.appQuestionnaireInvitation.update.mockResolvedValue(invitationRow());
});

describe('gate order + auth (collection)', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL))).status).toBe(
      401
    );
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL))).status).toBe(
      403
    );
  });
});

describe('POST — send invitations', () => {
  it('409s when the questionnaire has no launched version', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false); // full error envelope, not just the code
    expect(body.error.code).toBe('INVITE_NO_LAUNCHED_VERSION');
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
  });

  it('429s when the send rate limit is exceeded, before any work', async () => {
    (inviteLimiter.check as unknown as Mock).mockReturnValueOnce({
      success: false,
      remaining: 0,
      reset: 1,
    });
    const res = await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    expect(res.status).toBe(429);
    expect(prismaMock.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
  });

  it('creates + sends a single invitation and marks it sent', async () => {
    const res = await createPOST(
      req({ recipients: [{ email: 'Alice@Example.com', name: 'Alice' }] }),
      ctx(COLL)
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.results).toEqual([
      { email: 'alice@example.com', outcome: 'sent', invitationId: 'inv-new' },
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // status flipped pending → sent
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_invitation.create' })
    );
  });

  it('snapshots null demoClientId for a generic questionnaire and skips the theme lookup', async () => {
    await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    // DEMO-ONLY (F3.4): the brand snapshot is written even when null.
    expect(prismaMock.appQuestionnaireInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ demoClientId: null }) })
    );
    // No attributed client → no theme lookup at all (resolveDemoClientTheme short-circuits).
    expect(prismaMock.appDemoClient.findUnique).not.toHaveBeenCalled();
  });

  it('denormalises the attributed demoClientId onto the invitation and resolves the theme once', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      versionNumber: 2,
      questionnaire: { title: 'Customer Satisfaction', demoClientId: 'dc-acme' },
    });
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      ctaColor: '#ff0000',
      accentColor: null,
      logoUrl: 'https://acme.example/logo.png',
      welcomeCopy: 'Welcome to the Acme demo.',
    });

    await createPOST(req({ recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }), ctx(COLL));

    // Every created invitation carries the attributed client.
    for (const call of prismaMock.appQuestionnaireInvitation.create.mock.calls) {
      expect(call[0].data.demoClientId).toBe('dc-acme');
    }
    // Theme resolved ONCE for the whole batch (not per recipient).
    expect(prismaMock.appDemoClient.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.appDemoClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dc-acme' } })
    );
    // The resolved brand reaches the email render (accentColor defaulted from null).
    expect(QuestionnaireInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          ctaColor: '#ff0000',
          accentColor: SUNRISE_THEME_DEFAULTS.accentColor,
          logoUrl: 'https://acme.example/logo.png',
          welcomeCopy: 'Welcome to the Acme demo.',
        }),
      })
    );
  });

  it('falls back to the Sunrise theme when the snapshotted client was deleted (stale FK)', async () => {
    // demoClientId is set on the questionnaire, but the client row is gone (deleted
    // after attribution, before the SetNull cascade reached an in-flight send).
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      versionNumber: 2,
      questionnaire: { title: 'Customer Satisfaction', demoClientId: 'dc-gone' },
    });
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null); // client deleted

    await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));

    // The lookup was attempted (id non-null), but the miss resolves to the all-Sunrise
    // theme rather than throwing.
    expect(prismaMock.appDemoClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dc-gone' } })
    );
    expect(QuestionnaireInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          ctaColor: SUNRISE_THEME_DEFAULTS.ctaColor,
          accentColor: SUNRISE_THEME_DEFAULTS.accentColor,
          logoUrl: null,
          welcomeCopy: SUNRISE_THEME_DEFAULTS.welcomeCopy,
        }),
      })
    );
    // The invitation still records the snapshot id even though the client is gone.
    expect(prismaMock.appQuestionnaireInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ demoClientId: 'dc-gone' }) })
    );
  });

  it('skips a recipient with a live invitation (app-layer dedup)', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue({ id: 'inv-existing' });
    const res = await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    const body = await res.json();
    expect(body.data.results[0]).toMatchObject({
      outcome: 'skipped',
      invitationId: 'inv-existing',
    });
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('keeps a row at pending when the email send fails', async () => {
    (sendEmail as unknown as Mock).mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'boom',
    });
    const res = await createPOST(req({ recipients: [{ email: 'a@x.com' }] }), ctx(COLL));
    const body = await res.json();
    expect(body.data.results[0]).toMatchObject({ outcome: 'failed', invitationId: 'inv-new' });
    // No status flip to sent on failure.
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('degrades to a failed outcome (not a 500) when the email transport throws', async () => {
    // Production with email unconfigured: sendEmail THROWS rather than returning a result.
    (sendEmail as unknown as Mock).mockRejectedValue(new Error('Email system not configured'));
    const res = await createPOST(
      req({ recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }),
      ctx(COLL)
    );
    expect(res.status).toBe(201); // batch completes, not a 500
    const body = await res.json();
    expect(body.data.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      'failed',
      'failed',
    ]);
  });

  it('returns a per-recipient result for a bulk batch', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst
      .mockResolvedValueOnce(null) // a@x.com — fresh
      .mockResolvedValueOnce({ id: 'inv-dupe' }); // b@x.com — live
    prismaMock.appQuestionnaireInvitation.create.mockResolvedValue({ id: 'inv-a' });
    const res = await createPOST(
      req({ recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }),
      ctx(COLL)
    );
    const body = await res.json();
    expect(body.data.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      'sent',
      'skipped',
    ]);
  });

  it('rejects a batch with a duplicate email (400, before any DB write)', async () => {
    const res = await createPOST(
      req({ recipients: [{ email: 'a@x.com' }, { email: 'a@x.com' }] }),
      ctx(COLL)
    );
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
  });
});

describe('GET — list invitations', () => {
  it('returns views with pagination meta and never the token hash', async () => {
    prismaMock.appQuestionnaireInvitation.findMany.mockResolvedValue([invitationRow()]);
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(1);
    const res = await listGET(
      req(
        undefined,
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/invitations?page=1&limit=50'
      ),
      ctx(COLL)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('tokenHash');
    expect(body.meta).toMatchObject({ page: 1, limit: 50, total: 1 });
  });

  it('filters by status when a valid status is supplied', async () => {
    prismaMock.appQuestionnaireInvitation.findMany.mockResolvedValue([]);
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(0);
    await listGET(
      req(
        undefined,
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/invitations?status=revoked'
      ),
      ctx(COLL)
    );
    expect(prismaMock.appQuestionnaireInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'revoked' }) })
    );
  });
});

describe('PATCH — revoke', () => {
  it('404s when the invitation is not scoped to the questionnaire', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(null);
    const res = await revokePATCH(req({ action: 'revoke' }), ctx(SINGLE));
    expect(res.status).toBe(404);
  });

  it('revokes a sent invitation and audits it', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'sent' })
    );
    prismaMock.appQuestionnaireInvitation.update.mockResolvedValue(
      invitationRow({ status: 'revoked', revokedAt: new Date() })
    );
    const res = await revokePATCH(req({ action: 'revoke' }), ctx(SINGLE));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'revoked' }) })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_invitation.revoke' })
    );
  });

  it('409s when the invitation cannot be revoked (already registered)', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'registered' })
    );
    const res = await revokePATCH(req({ action: 'revoke' }), ctx(SINGLE));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('INVITATION_NOT_REVOCABLE');
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });
});

describe('POST — resend', () => {
  it('regenerates the token, clears openedAt, and sets sent — using the pinned version title', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'opened' })
    );
    prismaMock.appQuestionnaireInvitation.update.mockResolvedValue(invitationRow());
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.appQuestionnaireInvitation.update.mock.calls[0][0];
    // A fresh 64-hex token + refreshed expiry + sent timestamp are the write contract —
    // pin them, not just the presence of a `tokenHash` key.
    expect(updateArg.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArg.data).toMatchObject({
      status: 'sent',
      expiresAt: expect.any(Date),
      sentAt: expect.any(Date),
      openedAt: null, // respondent must re-open the new link
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_invitation.resend' })
    );
    // Title comes from the invitation's pinned version — NOT a launched-version lookup.
    expect(prismaMock.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaire.findUnique).not.toHaveBeenCalled();
  });

  it('409s when the invitation is not resendable (already registered)', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'registered' })
    );
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('INVITATION_NOT_RESENDABLE');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('themes the resend from the invitation’s own brand snapshot (not the questionnaire’s current client)', async () => {
    // The invitation was sent under dc-acme; resend must use that snapshot.
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'opened', demoClientId: 'dc-acme' })
    );
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      ctaColor: '#00ff00',
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    });
    prismaMock.appQuestionnaireInvitation.update.mockResolvedValue(invitationRow());

    await resendPOST(req(undefined), ctx(SINGLE));

    expect(prismaMock.appDemoClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dc-acme' } })
    );
    expect(QuestionnaireInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ theme: expect.objectContaining({ ctaColor: '#00ff00' }) })
    );
  });

  it('404s when the invitation is not scoped to the questionnaire', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(null);
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('429s when the resend rate limit is exceeded, before any work', async () => {
    (inviteLimiter.check as unknown as Mock).mockReturnValueOnce({
      success: false,
      remaining: 0,
      reset: 1,
    });
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(429);
    expect(prismaMock.appQuestionnaireInvitation.findFirst).not.toHaveBeenCalled();
  });

  it('preserves the existing token (no write) when the resend email fails', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'opened' })
    );
    (sendEmail as unknown as Mock).mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'down',
    });
    prismaMock.appQuestionnaireInvitation.findUniqueOrThrow.mockResolvedValue(invitationRow());
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(200);
    // The old link must keep working — no token overwrite on a failed send.
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
    expect((await res.json()).data.emailStatus).toBe('failed');
  });

  it('preserves the existing token when the resend email transport throws', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(
      scopedRow({ status: 'sent' })
    );
    (sendEmail as unknown as Mock).mockRejectedValue(new Error('email not configured'));
    prismaMock.appQuestionnaireInvitation.findUniqueOrThrow.mockResolvedValue(invitationRow());
    const res = await resendPOST(req(undefined), ctx(SINGLE));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });
});
