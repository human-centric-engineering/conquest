/**
 * Unit tests for the questionnaire definition export route (F14.9).
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/definition/route.ts
 *
 * Every collaborator is mocked at the module boundary. Tests assert what the
 * route DOES — status codes, response headers, content, collaborator call
 * arguments — not just what mocks return (anti-green-bar).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth: (handler: unknown) => handler,
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  exportLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaire: { findUnique: vi.fn() },
    appScoringSchema: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/app/questionnaire/authoring', () => ({
  buildDefinitionExport: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/scoring', () => ({
  narrowScoringSchemaContent: vi.fn((content: unknown) => content),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/detail', () => ({
  getVersionGraph: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-routes', () => ({
  loadDataSlots: vi.fn(),
}));

// ─── Deferred imports (after vi.mock) ─────────────────────────────────────────

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { GET } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/definition/route')) as {
    GET: AnyRouteHandler;
  };

import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { buildDefinitionExport } from '@/lib/app/questionnaire/authoring';
import { narrowScoringSchemaContent } from '@/lib/app/questionnaire/scoring';
import { getVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { loadDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

const GRAPH = {
  versionNumber: 3,
  status: 'draft',
  sections: [{ id: 'sec-1', title: 'About You', ordinal: 0, questions: [] }],
  goal: 'Assess wellbeing',
  audience: null,
};

const QUESTIONNAIRE_ROW = { title: 'Wellbeing Survey' };

const EXPORT_ENVELOPE = {
  __type: 'conquest:questionnaire-definition',
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  questionnaire: { title: 'Wellbeing Survey' },
  versionData: {
    versionNumber: 3,
    goal: 'Assess wellbeing',
    sections: [],
    tags: [],
    dataSlots: [],
    config: null,
    scoringSchema: null,
  },
};

function makeRequest(id = QN_ID, vid = VID) {
  return new NextRequest(
    `http://localhost/api/v1/app/questionnaires/${id}/versions/${vid}/definition`
  );
}

function makeContext(id = QN_ID, vid = VID) {
  return { params: Promise.resolve({ id, vid }) };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Rate limit passes by default
  (exportLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });

  // DB lookups succeed by default
  (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(QUESTIONNAIRE_ROW);
  (getVersionGraph as Mock).mockResolvedValue(GRAPH);
  (loadDataSlots as Mock).mockResolvedValue([]);
  (prisma.appScoringSchema.findUnique as Mock).mockResolvedValue(null);

  // Builder returns a canonical envelope
  (buildDefinitionExport as Mock).mockReturnValue(EXPORT_ENVELOPE);
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

describe('GET definition — rate limit', () => {
  it('returns the createRateLimitResponse result when exportLimiter rejects', async () => {
    (exportLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 9_999_999_999,
    });

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(createRateLimitResponse).toHaveBeenCalledOnce();
    expect(res).toBe(vi.mocked(createRateLimitResponse).mock.results[0]?.value);
    expect(res.status).toBe(429);

    // Rate limit key is scoped by user id, not a raw token
    expect(exportLimiter.check).toHaveBeenCalledWith('export:user:admin-1');

    // No downstream work should have happened
    expect(getVersionGraph).not.toHaveBeenCalled();
    expect(buildDefinitionExport).not.toHaveBeenCalled();
  });
});

// ─── Not found ────────────────────────────────────────────────────────────────

describe('GET definition — not found', () => {
  it('returns 404 NOT_FOUND when the questionnaire row is missing', async () => {
    (prisma.appQuestionnaire.findUnique as Mock).mockResolvedValue(null);

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    expect(buildDefinitionExport).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND when the version graph is missing', async () => {
    (getVersionGraph as Mock).mockResolvedValue(null);

    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    expect(buildDefinitionExport).not.toHaveBeenCalled();
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('GET definition — happy path', () => {
  it('returns 200 with JSON content-type and attachment disposition', async () => {
    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toMatch(/\.json"$/);
  });

  it('includes the questionnaire title slug and version number in the filename', async () => {
    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());

    const disposition = res.headers.get('Content-Disposition') ?? '';
    // Title is "Wellbeing Survey" → slug "wellbeing-survey", versionNumber is 3
    expect(disposition).toContain('wellbeing-survey');
    expect(disposition).toContain('-v3-');
  });

  it('sets Cache-Control: no-store', async () => {
    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());

    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('passes the questionnaire title, graph, data slots, and scoring to buildDefinitionExport', async () => {
    const dataSlots = [{ id: 'ds-1', name: 'Name', key: 'name', ordinal: 0 }];
    (loadDataSlots as Mock).mockResolvedValue(dataSlots);

    const schemaContent = { items: [], scales: [], bands: [] };
    (prisma.appScoringSchema.findUnique as Mock).mockResolvedValue({
      name: 'Standard',
      content: schemaContent,
    });
    (narrowScoringSchemaContent as Mock).mockReturnValue(schemaContent);

    const req = makeRequest();
    await GET(req, ADMIN_SESSION, makeContext());

    expect(buildDefinitionExport).toHaveBeenCalledWith(
      QUESTIONNAIRE_ROW.title,
      GRAPH,
      dataSlots,
      // scoring arg — the route narrows the schema content and wraps it
      expect.objectContaining({ name: 'Standard', content: schemaContent }),
      expect.any(String) // ISO timestamp
    );
  });

  it('passes null scoring to buildDefinitionExport when no scoring schema row exists', async () => {
    (prisma.appScoringSchema.findUnique as Mock).mockResolvedValue(null);

    const req = makeRequest();
    await GET(req, ADMIN_SESSION, makeContext());

    const callArgs = (buildDefinitionExport as Mock).mock.calls[0] as unknown[];
    const scoringArg = callArgs[3]; // 4th positional argument
    expect(scoringArg).toBeNull();
  });

  it('serialises the envelope built by buildDefinitionExport, not the raw graph', async () => {
    // The mock returns EXPORT_ENVELOPE; a different shape than the raw GRAPH — this
    // proves the route serialises what the builder returned, not some other object.
    const req = makeRequest();
    const res = await GET(req, ADMIN_SESSION, makeContext());
    const text = await res.text();
    const parsed = JSON.parse(text) as typeof EXPORT_ENVELOPE;

    expect(parsed).toMatchObject({
      __type: 'conquest:questionnaire-definition',
      questionnaire: { title: 'Wellbeing Survey' },
    });
  });

  it('uses the id and vid path params to scope the version graph lookup', async () => {
    const req = makeRequest('qn-999', 'ver-999');
    await GET(req, ADMIN_SESSION, makeContext('qn-999', 'ver-999'));

    expect(getVersionGraph).toHaveBeenCalledWith('qn-999', 'ver-999');
    expect(prisma.appQuestionnaire.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'qn-999' } })
    );
  });
});
