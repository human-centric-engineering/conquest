/**
 * DEMO-ONLY (F2.5.1) integration test: demo-client CRUD routes.
 *
 * Exercises the HTTP orchestration with the DB seam mocked — gate order, auth,
 * 404 mapping, slug derive-on-create, the slug-conflict 409, the delete 409-guard
 * (refuse while attributed), and audit emission. The read-model query shape is
 * mocked here; its projection is unit-tested in _lib/read.test.ts.
 *
 *   GET    /api/v1/app/demo-clients        — list
 *   POST   /api/v1/app/demo-clients        — create
 *   GET    /api/v1/app/demo-clients/:id    — detail
 *   PATCH  /api/v1/app/demo-clients/:id    — update
 *   DELETE /api/v1/app/demo-clients/:id    — delete (guarded)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  appDemoClient: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Mock only the DB-touching query fns; keep the pure DEMO_CLIENT_SELECT +
// toDemoClientView real (the create/update routes import them to project rows).
vi.mock('@/app/api/v1/app/demo-clients/_lib/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/api/v1/app/demo-clients/_lib/read')>();
  return { ...real, listDemoClients: vi.fn(), getDemoClientDetail: vi.fn() };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as listGET, POST as createPOST } from '@/app/api/v1/app/demo-clients/route';
import { MAX_STORED_CANDIDATES } from '@/lib/app/questionnaire/brand-import/palette-record';
import {
  GET as detailGET,
  PATCH as updatePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/v1/app/demo-clients/[id]/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { listDemoClients, getDemoClientDetail } from '@/app/api/v1/app/demo-clients/_lib/read';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function getReq(url = 'http://localhost:3000/api/v1/app/demo-clients'): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function jsonReq(
  body: unknown,
  url = 'http://localhost:3000/api/v1/app/demo-clients'
): NextRequest {
  return { url, headers: new Headers(), json: async () => body } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const ROW = {
  id: 'dc-1',
  slug: 'acme-bank',
  name: 'Acme Bank',
  description: null,
  isActive: true,
  // F3.4 theme columns (null = Sunrise default) — part of DEMO_CLIENT_SELECT.
  ctaColor: null,
  accentColor: null,
  logoUrl: null,
  welcomeCopy: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  _count: { questionnaires: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
});

describe('GET /api/v1/app/demo-clients (list)', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await listGET(getReq())).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await listGET(getReq())).status).toBe(403);
  });

  it('returns the clients for an admin', async () => {
    (listDemoClients as unknown as Mock).mockResolvedValue([
      { ...ROW, createdAt: '', updatedAt: '' },
    ]);
    const res = await listGET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    // F3.4: the projection carries the theme shape (guards against toDemoClientView
    // dropping the theme fields).
    expect(body.data[0]).toMatchObject({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    });
  });
});

describe('POST /api/v1/app/demo-clients (create)', () => {
  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await createPOST(jsonReq({ name: 'Acme Bank' }))).status).toBe(403);
  });

  it('derives the slug from the name when omitted, and audits', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue(ROW);
    const res = await createPOST(jsonReq({ name: 'Acme Bank' }));
    expect(res.status).toBe(201);
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: 'acme-bank' }) })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_demo_client.create' })
    );
  });

  it('honours an explicit slug', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue({ ...ROW, slug: 'custom' });
    await createPOST(jsonReq({ name: 'Acme Bank', slug: 'custom' }));
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: 'custom' }) })
    );
  });

  it('400s on a malformed slug', async () => {
    expect((await createPOST(jsonReq({ name: 'Acme', slug: 'Bad Slug' }))).status).toBe(400);
    expect(prismaMock.appDemoClient.create).not.toHaveBeenCalled();
  });

  it('409s on a slug collision (P2002)', async () => {
    prismaMock.appDemoClient.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );
    const res = await createPOST(jsonReq({ name: 'Acme Bank' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false); // full error envelope, not just the code
    expect(body.error.code).toBe('SLUG_CONFLICT');
  });

  it('persists the F3.4 theme fields when supplied', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue({
      ...ROW,
      ctaColor: '#ff0000',
      logoUrl: 'https://acme.example/logo.png',
    });
    await createPOST(
      jsonReq({
        name: 'Acme Bank',
        ctaColor: '#ff0000',
        logoUrl: 'https://acme.example/logo.png',
        welcomeCopy: 'Welcome to the Acme demo.',
      })
    );
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ctaColor: '#ff0000',
          logoUrl: 'https://acme.example/logo.png',
          welcomeCopy: 'Welcome to the Acme demo.',
        }),
      })
    );
  });

  it('persists the F7.2 bannerUrl alongside the logo', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue({
      ...ROW,
      bannerUrl: 'https://acme.example/banner.jpg',
    });
    await createPOST(jsonReq({ name: 'Acme Bank', bannerUrl: 'https://acme.example/banner.jpg' }));
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bannerUrl: 'https://acme.example/banner.jpg' }),
      })
    );
  });

  it('persists the brand-kit fields — the ground, the type and the extra marks', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue(ROW);
    await createPOST(
      jsonReq({
        name: 'Acme Bank',
        canvasColor: '#0b1f3a',
        inkColor: '#f5f9ff',
        canvasColorDark: '#050d1a',
        inkColorDark: '#dbeafe',
        accentColorEnd: '#0ea5e9',
        logoMarkUrl: 'https://acme.example/mark.png',
        logoDarkUrl: 'https://acme.example/logo-dark.png',
        fontPairing: 'editorial',
      })
    );
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          canvasColor: '#0b1f3a',
          inkColor: '#f5f9ff',
          canvasColorDark: '#050d1a',
          inkColorDark: '#dbeafe',
          accentColorEnd: '#0ea5e9',
          logoMarkUrl: 'https://acme.example/mark.png',
          logoDarkUrl: 'https://acme.example/logo-dark.png',
          fontPairing: 'editorial',
        }),
      })
    );
  });

  it('rejects a font pairing this build does not know', async () => {
    // Strict on the WRITE boundary even though the read path resolves an unknown value to
    // neutral: a typo should be told to the admin rather than stored and silently ignored.
    const res = await createPOST(jsonReq({ name: 'Acme Bank', fontPairing: 'gothic' }));
    expect(res.status).toBe(400);
    expect(prismaMock.appDemoClient.create).not.toHaveBeenCalled();
  });

  it('accepts an uploaded /uploads/ path, not just an https URL', async () => {
    // The local storage provider serves from public/uploads/, so an https-only rule would
    // reject every logo uploaded in development.
    prismaMock.appDemoClient.create.mockResolvedValue(ROW);
    const res = await createPOST(
      jsonReq({ name: 'Acme Bank', logoUrl: '/uploads/demo-clients/dc-1/logo/logo.png?v=1' })
    );
    expect(res.status).toBe(201);
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logoUrl: '/uploads/demo-clients/dc-1/logo/logo.png?v=1',
        }),
      })
    );
  });

  it('rejects a brand image src that is neither https nor an upload path', async () => {
    const res = await createPOST(jsonReq({ name: 'Acme Bank', bannerUrl: 'javascript:alert(1)' }));
    expect(res.status).toBe(400);
    expect(prismaMock.appDemoClient.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/app/demo-clients/:id (detail)', () => {
  it('404s when unknown', async () => {
    (getDemoClientDetail as unknown as Mock).mockResolvedValue(null);
    expect((await detailGET(getReq(), ctx({ id: 'missing' }))).status).toBe(404);
  });

  it('returns the client for an admin', async () => {
    (getDemoClientDetail as unknown as Mock).mockResolvedValue({
      ...ROW,
      createdAt: '',
      updatedAt: '',
    });
    expect((await detailGET(getReq(), ctx({ id: 'dc-1' }))).status).toBe(200);
  });
});

describe('PATCH /api/v1/app/demo-clients/:id (update)', () => {
  it('404s when unknown', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    const res = await updatePATCH(jsonReq({ name: 'New' }), ctx({ id: 'missing' }));
    expect(res.status).toBe(404);
    expect(prismaMock.appDemoClient.update).not.toHaveBeenCalled();
  });

  it('updates and audits', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue({ ...ROW, name: 'Acme Bank EU' });
    const res = await updatePATCH(jsonReq({ name: 'Acme Bank EU' }), ctx({ id: 'dc-1' }));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_demo_client.update' })
    );
  });

  it('409s on a slug collision (P2002)', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );
    const res = await updatePATCH(jsonReq({ slug: 'taken' }), ctx({ id: 'dc-1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SLUG_CONFLICT');
  });

  it('re-throws a database error that is not a slug collision, rather than reporting a fake 409', async () => {
    // Only P2002 (unique-constraint) means "the slug is taken" — any other failure (a different
    // constraint, a connection drop) must propagate rather than get relabelled as a slug conflict
    // the admin would go looking for and not find. `withAdminAuth` is the real implementation in
    // this integration file, so the propagated error surfaces as its own 500 — not as the 409
    // `SLUG_CONFLICT` shape the P2002 branch above returns.
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockRejectedValue(new Error('connection reset'));
    const res = await updatePATCH(jsonReq({ name: 'Renamed' }), ctx({ id: 'dc-1' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).not.toBe('SLUG_CONFLICT');
  });

  it('patches the F3.4 theme fields, including clearing one to null', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue({ ...ROW, ctaColor: '#000000' });
    const res = await updatePATCH(
      jsonReq({ ctaColor: '#000000', welcomeCopy: null }),
      ctx({ id: 'dc-1' })
    );
    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ctaColor: '#000000', welcomeCopy: null }),
      })
    );
  });

  it('patches every field the update handler recognises, in one round trip', async () => {
    // The handler is one `data:` object built entirely from `field !== undefined ? {...} : {}`
    // ternaries — a present-vs-omitted branch per column. The tests above and below each exercise
    // a handful; this fills in the rest (identity, chrome, and dark-mode/mark columns) so every
    // ternary's PRESENT arm is proven to actually reach Prisma, not just the handful the narrower
    // tests happen to touch.
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    const patch = {
      description: 'Updated note',
      isActive: false,
      accentColor: '#2f6bff',
      logoUrl: 'https://cdn.example.com/logo.png',
      bannerUrl: 'https://cdn.example.com/banner.png',
      surfaceColor: '#280039',
      ctaColorEnd: '#FF03DF',
      logoBackgroundColor: '#111111',
      logoBackgroundEnabled: true,
      inkColor: '#1a1a1a',
      canvasColorDark: '#0a0a0a',
      inkColorDark: '#fafafa',
      accentColorEnd: '#7b5cff',
      logoMarkUrl: 'https://cdn.example.com/mark.png',
      logoDarkUrl: 'https://cdn.example.com/logo-dark.png',
    };

    const res = await updatePATCH(jsonReq(patch), ctx({ id: 'dc-1' }));

    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(patch) })
    );
  });
});

describe('PATCH /api/v1/app/demo-clients/:id (brand kit)', () => {
  it('clears a canvas back to null, so a client can drop their ground entirely', async () => {
    // The path an admin takes to undo an experiment. `null` must reach the column — an
    // omitted key means "leave it alone", which would strand the questionnaire on a ground
    // the admin has already deleted from the form.
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    const res = await updatePATCH(
      jsonReq({ canvasColor: null, fontPairing: null }),
      ctx({ id: 'dc-1' })
    );
    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ canvasColor: null, fontPairing: null }),
      })
    );
  });

  it('leaves brand-kit columns untouched when the patch omits them', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    await updatePATCH(jsonReq({ name: 'Renamed' }), ctx({ id: 'dc-1' }));
    const data = prismaMock.appDemoClient.update.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    for (const col of ['canvasColor', 'inkColor', 'accentColorEnd', 'fontPairing']) {
      expect(data).not.toHaveProperty(col);
    }
  });
});

describe('the measured brand palette (write boundary)', () => {
  const PALETTE = {
    candidates: [
      { hex: '#0a1a3a', share: 0.42, neutral: false },
      { hex: '#fffcf5', share: 0.31, neutral: true },
    ],
    readFrom: 'acme.example',
    capturedAt: '2026-08-31T09:00:00.000Z',
  };

  it('persists a palette applied alongside the colours it produced', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    const res = await updatePATCH(
      jsonReq({ ctaColor: '#0a1a3a', brandPalette: PALETTE }),
      ctx({ id: 'dc-1' })
    );
    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ brandPalette: PALETTE }) })
    );
  });

  it('clears the column with a JSON DbNull rather than storing a JSON null', async () => {
    // `Prisma.DbNull` is SQL NULL; a bare `null` on a Json column stores the JSON value `null`,
    // which narrows to null on read but is not the same "never had one" state the strip tests.
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    await updatePATCH(jsonReq({ brandPalette: null }), ctx({ id: 'dc-1' }));
    const data = prismaMock.appDemoClient.update.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.brandPalette).toBe(Prisma.DbNull);
  });

  it('leaves the column untouched when the patch omits it', async () => {
    // The common case: an admin nudging one colour must not discard the measurement the whole
    // theme was read from.
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    prismaMock.appDemoClient.update.mockResolvedValue(ROW);
    await updatePATCH(jsonReq({ ctaColor: '#0a1a3a' }), ctx({ id: 'dc-1' }));
    const data = prismaMock.appDemoClient.update.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data).not.toHaveProperty('brandPalette');
  });

  it('400s on a palette whose shares are percentages rather than fractions', async () => {
    // The strip renders share as a band width and a percentage label; 42 rather than 0.42 draws
    // one colour and reads "4200.0%".
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    const res = await updatePATCH(
      jsonReq({
        brandPalette: {
          ...PALETTE,
          candidates: [{ hex: '#0a1a3a', share: 42, neutral: false }],
        },
      }),
      ctx({ id: 'dc-1' })
    );
    expect(res.status).toBe(400);
    expect(prismaMock.appDemoClient.update).not.toHaveBeenCalled();
  });

  it('400s on a palette with more candidates than the column will hold', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(ROW);
    const res = await updatePATCH(
      jsonReq({
        brandPalette: {
          ...PALETTE,
          candidates: Array.from({ length: MAX_STORED_CANDIDATES + 1 }, (_, i) => ({
            hex: `#0000${i.toString(16).padStart(2, '0')}`,
            share: 0.01,
            neutral: false,
          })),
        },
      }),
      ctx({ id: 'dc-1' })
    );
    expect(res.status).toBe(400);
  });

  it('persists a palette supplied on create', async () => {
    prismaMock.appDemoClient.create.mockResolvedValue(ROW);
    const res = await createPOST(jsonReq({ name: 'Acme Bank', brandPalette: PALETTE }));
    expect(res.status).toBe(201);
    expect(prismaMock.appDemoClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ brandPalette: PALETTE }) })
    );
  });
});

describe('DELETE /api/v1/app/demo-clients/:id (guarded)', () => {
  it('404s when unknown', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue(null);
    expect((await deleteDELETE(getReq(), ctx({ id: 'missing' }))).status).toBe(404);
  });

  it('409s while questionnaires are still attributed (and does not delete)', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme Bank',
      slug: 'acme-bank',
      _count: { questionnaires: 2 },
    });
    const res = await deleteDELETE(getReq(), ctx({ id: 'dc-1' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DEMO_CLIENT_IN_USE');
    expect(prismaMock.appDemoClient.delete).not.toHaveBeenCalled();
  });

  it('deletes when unattributed, and audits', async () => {
    prismaMock.appDemoClient.findUnique.mockResolvedValue({
      id: 'dc-1',
      name: 'Acme Bank',
      slug: 'acme-bank',
      _count: { questionnaires: 0 },
    });
    prismaMock.appDemoClient.delete.mockResolvedValue({ id: 'dc-1' });
    const res = await deleteDELETE(getReq(), ctx({ id: 'dc-1' }));
    expect(res.status).toBe(200);
    expect(prismaMock.appDemoClient.delete).toHaveBeenCalledWith({ where: { id: 'dc-1' } });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app_demo_client.delete' })
    );
  });
});
