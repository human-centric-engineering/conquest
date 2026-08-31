/**
 * Unit tests: the contrast-optimiser route.
 *
 * A thin route, and its two decisions are both about the body:
 *
 *  - **the theme is SENT, not loaded.** That is the whole reason the endpoint takes a body. An
 *    admin presses this in the middle of adjusting colours, and reading the saved row would audit
 *    colours they have already moved on from. These tests pin that nothing is read from the
 *    database and that `demoClientId` is context, never a lookup key.
 *  - **it validates with the same schema the save does.** A body that passed here and failed on
 *    PATCH would let an admin accept a proposal they can never store.
 *
 * Plus the gate order, and the failure contract it shares with the import: a theme with no problems
 * is a 200 that says so, because an admin who pressed the button is owed an answer either way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

const limiterMock = vi.hoisted(() => ({
  brandContrastLimiter: { check: vi.fn(() => ({ success: true, reset: 0 })) },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => limiterMock);

const optimiseMock = vi.hoisted(() => ({ optimiseContrast: vi.fn() }));
vi.mock('@/lib/app/questionnaire/brand-contrast', () => optimiseMock);

// Imported so a stray database read in the handler would be visible as a call on this mock rather
// than as a connection attempt.
const prismaMock = vi.hoisted(() => ({
  prisma: { appDemoClient: { findUnique: vi.fn(), findMany: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => prismaMock);

import { POST } from '@/app/api/v1/app/demo-clients/optimise-contrast/route';

type Handler = (request: Request, session: unknown) => Promise<Response>;
const post = POST as unknown as Handler;

const SESSION = { user: { id: 'admin-1' } };

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/v1/app/demo-clients/optimise-contrast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CLEAN = {
  outcome: 'clean',
  proposals: [],
  unfixable: [],
  degraded: false,
  summary: 'Every colour pairing on the respondent surface clears WCAG AA. Nothing to change.',
};

beforeEach(() => {
  vi.clearAllMocks();
  limiterMock.brandContrastLimiter.check.mockReturnValue({ success: true, reset: 0 });
  optimiseMock.optimiseContrast.mockResolvedValue(CLEAN);
});

describe('POST /api/v1/app/demo-clients/optimise-contrast', () => {
  it('audits the theme it was sent', async () => {
    const res = await post(
      jsonRequest({ theme: { canvasColor: '#fffcf5', inkColor: '#9a9a8f' } }),
      SESSION
    );

    expect(res.status).toBe(200);
    expect(optimiseMock.optimiseContrast).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ canvasColor: '#fffcf5', inkColor: '#9a9a8f' }),
      })
    );
  });

  it('never reads the client row — the unsaved theme is the point', async () => {
    // Loading the row would audit the colours the admin has already moved on from, which is the
    // one behaviour that would make the feature useless while appearing to work.
    await post(jsonRequest({ theme: { canvasColor: '#fffcf5' }, demoClientId: 'dc-1' }), SESSION);
    expect(prismaMock.prisma.appDemoClient.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.prisma.appDemoClient.findMany).not.toHaveBeenCalled();
  });

  it('passes the client id through as cost context', async () => {
    await post(jsonRequest({ theme: {}, demoClientId: 'dc-1' }), SESSION);
    expect(optimiseMock.optimiseContrast).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'dc-1' })
    );
  });

  it('works with no client id at all, for the create form', async () => {
    const res = await post(jsonRequest({ theme: { ctaColor: '#7a7a7a' } }), SESSION);
    expect(res.status).toBe(200);
  });

  it('normalises the four required-but-nullable columns to null when omitted', async () => {
    // `DemoClientTheme` declares them required; the schema makes every field optional. Left
    // undefined they would still resolve correctly, but spelling them out keeps the contract the
    // resolver declares actually satisfied rather than satisfied by coincidence.
    await post(jsonRequest({ theme: { canvasColor: '#fffcf5' } }), SESSION);
    const { theme } = optimiseMock.optimiseContrast.mock.calls[0][0];
    expect(theme.ctaColor).toBeNull();
    expect(theme.accentColor).toBeNull();
    expect(theme.logoUrl).toBeNull();
    expect(theme.welcomeCopy).toBeNull();
  });

  it('returns a clean result as a 200 that says so, not an empty body', async () => {
    const res = await post(jsonRequest({ theme: {} }), SESSION);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe('clean');
    expect(body.data.summary).toMatch(/clears WCAG AA/i);
  });

  it('rejects a colour that is not a hex, using the same rule the save does', async () => {
    // A body that passed here and failed on PATCH would let an admin accept a proposal they can
    // never store. `withAdminAuth` is stubbed to the identity in this file, so the guard's
    // APIError-to-400 mapping is not in play — the throw is what the route contributes.
    await expect(post(jsonRequest({ theme: { canvasColor: 'cream' } }), SESSION)).rejects.toThrow(
      'A theme is required'
    );
    expect(optimiseMock.optimiseContrast).not.toHaveBeenCalled();
  });

  it('rejects a body with no theme at all', async () => {
    await expect(post(jsonRequest({ demoClientId: 'dc-1' }), SESSION)).rejects.toThrow(
      'A theme is required'
    );
  });

  it('turns malformed JSON into the same rejection, never an unhandled parse error', async () => {
    // `request.json()` rejects on malformed input; the `.catch(() => null)` ahead of `safeParse`
    // is what keeps that from escaping as a 500 the admin cannot act on.
    await expect(
      post(
        new Request('http://localhost/api/v1/app/demo-clients/optimise-contrast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        }),
        SESSION
      )
    ).rejects.toThrow('A theme is required');
  });

  it('429s before doing any work when the admin is over the sub-cap', async () => {
    limiterMock.brandContrastLimiter.check.mockReturnValue({ success: false, reset: 1 });
    const res = await post(jsonRequest({ theme: {} }), SESSION);
    expect(res.status).toBe(429);
    expect(optimiseMock.optimiseContrast).not.toHaveBeenCalled();
  });

  it('keys the sub-cap on the admin, not the client', async () => {
    // The spend attaches to whoever pressed the button; two admins branding the same client should
    // not throttle each other.
    await post(jsonRequest({ theme: {}, demoClientId: 'dc-1' }), SESSION);
    expect(limiterMock.brandContrastLimiter.check).toHaveBeenCalledWith('admin-1');
  });
});
