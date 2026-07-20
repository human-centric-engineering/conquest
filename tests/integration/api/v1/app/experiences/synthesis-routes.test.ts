/**
 * Integration test: Experience-wide synthesis routes (P15.8).
 *
 * GET  /api/v1/app/experiences/:id/synthesis
 * POST /api/v1/app/experiences/:id/synthesis/generate
 *
 * The route shells are thin: an experience-existence gate, then a call into the
 * synthesis lib (material assembly, the LLM generation call, and persistence). Those
 * lib functions are mocked at their module boundary — exactly like
 * `workflows-routes.test.ts` mocks `enrichWorkflow` — so this file proves the ROUTE's
 * own branching (gate order, 409/429/502 mapping, the begin→generate→complete/fail
 * sequence) rather than re-testing the lib internals.
 *
 * @see app/api/v1/app/experiences/[id]/synthesis/route.ts
 * @see app/api/v1/app/experiences/[id]/synthesis/generate/route.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

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
  appExperience: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const persistMock = vi.hoisted(() => ({
  getExperienceSynthesisView: vi.fn(),
  beginExperienceSynthesis: vi.fn(),
  completeExperienceSynthesis: vi.fn(),
  failExperienceSynthesis: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/experiences/synthesis/persist', () => persistMock);

const materialMock = vi.hoisted(() => ({ buildSynthesisMaterial: vi.fn() }));
vi.mock('@/lib/app/questionnaire/experiences/synthesis/material', () => materialMock);

const generateMock = vi.hoisted(() => ({ generateExperienceSynthesis: vi.fn() }));
vi.mock('@/lib/app/questionnaire/experiences/synthesis/generate', () => generateMock);

const limiterMock = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  cohortReportGenerateLimiter: limiterMock,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/app/experiences/[id]/synthesis/route';
import { POST } from '@/app/api/v1/app/experiences/[id]/synthesis/generate/route';

import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const EXPERIENCE_ID = 'exp-1';

function req(): NextRequest {
  return {
    url: `http://localhost:3000/api/v1/app/experiences/${EXPERIENCE_ID}/synthesis`,
    headers: new Headers(),
    json: async () => undefined,
  } as unknown as NextRequest;
}

function ctx(id: string = EXPERIENCE_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

interface SynthesisView {
  exists: boolean;
  status: string;
  content: unknown;
  coveredSteps: number;
  eligibleSteps: number;
  costUsd: number | null;
  error: string | null;
  generatedAt: string | null;
}

function emptyView(): SynthesisView {
  return {
    exists: false,
    status: 'queued',
    content: null,
    coveredSteps: 0,
    eligibleSteps: 0,
    costUsd: null,
    error: null,
    generatedAt: null,
  };
}

function storedView(overrides: Partial<SynthesisView> = {}): SynthesisView {
  return {
    exists: true,
    status: 'ready',
    content: { narrative: 'It went fine.', findings: [], divergences: [], caveats: [] },
    coveredSteps: 2,
    eligibleSteps: 3,
    costUsd: 0.04,
    error: null,
    generatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function rateLimitOk() {
  return { success: true, limit: 10, remaining: 9, reset: Math.floor(Date.now() / 1000) + 60 };
}

function rateLimitExceeded() {
  return { success: false, limit: 10, remaining: 0, reset: Math.floor(Date.now() / 1000) + 60 };
}

function readyMaterial() {
  return {
    experienceTitle: 'Onboarding journey',
    experienceKind: 'agentic_switcher',
    blocks: [{ stepKey: 'intake', stepTitle: 'Intake', stepKind: 'entry', body: 'People said X.' }],
    coverage: [{ stepKey: 'intake', stepTitle: 'Intake', included: true, reason: 'included' }],
    routing: [],
    concludedRuns: 4,
  };
}

function emptyMaterial() {
  return {
    experienceTitle: 'Onboarding journey',
    experienceKind: 'agentic_switcher',
    blocks: [],
    coverage: [
      { stepKey: 'intake', stepTitle: 'Intake', included: false, reason: 'no_report' },
      { stepKey: 'branch-a', stepTitle: 'Branch A', included: false, reason: 'not_ready' },
    ],
    routing: [],
    concludedRuns: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appExperience.findUnique.mockResolvedValue({
    id: EXPERIENCE_ID,
    title: 'Onboarding journey',
  });
  limiterMock.check.mockReturnValue(rateLimitOk());
});

// =============================================================================
// GET /synthesis
// =============================================================================

describe('GET /api/v1/app/experiences/:id/synthesis', () => {
  it('403s for a non-admin without touching the experience or the view', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(prismaMock.appExperience.findUnique).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('404s when the experience does not exist, without ever reading the view', async () => {
    prismaMock.appExperience.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx('missing-exp'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // Existence check gates the view read — a missing experience never reaches persist.
    expect(persistMock.getExperienceSynthesisView).not.toHaveBeenCalled();
  });

  it('200s with the stored view when a synthesis exists', async () => {
    const view = storedView();
    persistMock.getExperienceSynthesisView.mockResolvedValue(view);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The route wraps the resolved view verbatim in the envelope.
    expect(body.data).toEqual(view);
    expect(persistMock.getExperienceSynthesisView).toHaveBeenCalledWith(EXPERIENCE_ID);
  });

  it('200s (never 404s) with the empty "never generated" view', async () => {
    persistMock.getExperienceSynthesisView.mockResolvedValue(emptyView());

    const res = await GET(req(), ctx());
    // The load-bearing behaviour: an experience that exists but has no synthesis yet
    // is a 200 with exists:false, not a 404 — the panel renders "not generated yet".
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.exists).toBe(false);
    expect(body.data.content).toBeNull();
  });
});

// =============================================================================
// POST /synthesis/generate
// =============================================================================

describe('POST /api/v1/app/experiences/:id/synthesis/generate', () => {
  beforeEach(() => {
    materialMock.buildSynthesisMaterial.mockResolvedValue(readyMaterial());
    generateMock.generateExperienceSynthesis.mockResolvedValue({
      content: { narrative: 'Across the journey...', findings: [], divergences: [], caveats: [] },
      costUsd: 0.12,
    });
    persistMock.beginExperienceSynthesis.mockResolvedValue('synthesis-row-1');
    persistMock.completeExperienceSynthesis.mockResolvedValue(undefined);
    persistMock.getExperienceSynthesisView.mockResolvedValue(storedView());
  });

  it('403s for a non-admin without touching the experience or the limiter', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(prismaMock.appExperience.findUnique).not.toHaveBeenCalled();
    expect(limiterMock.check).not.toHaveBeenCalled();
  });

  it('404s when the experience does not exist, before checking the rate limit', async () => {
    prismaMock.appExperience.findUnique.mockResolvedValue(null);
    const res = await POST(req(), ctx('missing-exp'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(limiterMock.check).not.toHaveBeenCalled();
    expect(materialMock.buildSynthesisMaterial).not.toHaveBeenCalled();
  });

  it('happy path: begins, generates, completes, audit-logs, and returns the refreshed view', async () => {
    const refreshed = storedView({ costUsd: 0.12 });
    persistMock.getExperienceSynthesisView.mockResolvedValue(refreshed);

    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Response is the POST-generation view, not the material or the raw generation result.
    expect(body.data).toEqual(refreshed);

    // The full begin → generate → complete sequence ran with the right args.
    expect(persistMock.beginExperienceSynthesis).toHaveBeenCalledWith(
      EXPERIENCE_ID,
      expect.any(String)
    );
    expect(generateMock.generateExperienceSynthesis).toHaveBeenCalledWith(readyMaterial());
    expect(persistMock.completeExperienceSynthesis).toHaveBeenCalledWith({
      experienceId: EXPERIENCE_ID,
      content: { narrative: 'Across the journey...', findings: [], divergences: [], caveats: [] },
      coveredSteps: 1,
      eligibleSteps: 1,
      costUsd: 0.12,
    });
    // Never marked failed on the success path.
    expect(persistMock.failExperienceSynthesis).not.toHaveBeenCalled();

    // Audit log carries the real coverage/cost figures, not placeholders.
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'app_experience_synthesis.generate',
        entityType: 'app_experience_synthesis',
        entityId: EXPERIENCE_ID,
        entityName: 'Onboarding journey',
        metadata: expect.objectContaining({
          experienceKind: 'agentic_switcher',
          coveredSteps: 1,
          eligibleSteps: 1,
          costUsd: 0.12,
        }),
      })
    );
  });

  it('409s NOTHING_TO_SYNTHESISE with coverage attached when no step has a finished report', async () => {
    const material = emptyMaterial();
    materialMock.buildSynthesisMaterial.mockResolvedValue(material);

    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOTHING_TO_SYNTHESISE');
    // The coverage explaining WHICH steps are missing is attached, not just the code.
    expect(body.error.details.coverage).toEqual(material.coverage);

    // Nothing was begun, generated, or persisted — this is a clean early return.
    expect(persistMock.beginExperienceSynthesis).not.toHaveBeenCalled();
    expect(generateMock.generateExperienceSynthesis).not.toHaveBeenCalled();
  });

  it('429s when the generate sub-cap is exceeded, before any material is built', async () => {
    limiterMock.check.mockReturnValue(rateLimitExceeded());

    const res = await POST(req(), ctx());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // The cap is keyed on the admin, and it short-circuits before any paid work.
    expect(limiterMock.check).toHaveBeenCalledWith(expect.any(String));
    expect(materialMock.buildSynthesisMaterial).not.toHaveBeenCalled();
    expect(persistMock.beginExperienceSynthesis).not.toHaveBeenCalled();
  });

  it('502s GENERATION_FAILED and marks the row failed (not stuck processing) when generation throws', async () => {
    generateMock.generateExperienceSynthesis.mockRejectedValue(new Error('LLM timed out'));

    const res = await POST(req(), ctx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('GENERATION_FAILED');

    // The row was begun (moved to processing) and then explicitly failed — proving the
    // record does not stay stuck in a running state when generation throws.
    expect(persistMock.beginExperienceSynthesis).toHaveBeenCalledWith(
      EXPERIENCE_ID,
      expect.any(String)
    );
    expect(persistMock.failExperienceSynthesis).toHaveBeenCalledWith(
      EXPERIENCE_ID,
      expect.stringContaining('LLM timed out')
    );
    // The failed path never reaches completion or the audit log.
    expect(persistMock.completeExperienceSynthesis).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
