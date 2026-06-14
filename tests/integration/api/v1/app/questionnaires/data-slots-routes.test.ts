/**
 * Integration tests: data-slots CRUD + generation routes (Data Slots feature).
 *
 * Covers the two adjacent route files:
 *   GET  /api/v1/app/questionnaires/:id/versions/:vid/data-slots  → list slots + draft
 *   PUT  /api/v1/app/questionnaires/:id/versions/:vid/data-slots  → replace slots (fork if launched)
 *   POST /api/v1/app/questionnaires/:id/versions/:vid/data-slots/generate → LLM-backed generation
 *
 * Gate order for all handlers: master flag + data-slots sub-flag off → 404 before auth;
 * non-admin → 403; unauthenticated → 401; missing/cross-id version → 404.
 *
 * Covers: 404 flag-off · 401 · 403 · 404 scope · GET returns slots+draft · PUT validates
 * body (400/422) · PUT forks launched version + retires source draft · audit row written ·
 * POST generate happy path + fail-soft · dispatch error codes → HTTP statuses · rate-limit 429.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appDataSlot: { findMany: vi.fn(), count: vi.fn() },
  appDataSlotDraft: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  appQuestionSlot: { findMany: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

// The generate route flushes capability handlers before dispatching (same pattern as
// route.test.ts / reingest-routes.test.ts). No-op here so the mocked dispatcher stands alone.
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Mock the DB-touching seam helpers. Keep schema/validator real; mock only writers + loaders.
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/data-slot-routes')>();
  return {
    ...real,
    loadDataSlots: vi.fn(),
    loadDataSlotDraft: vi.fn(),
    replaceDataSlots: vi.fn(),
    deleteDataSlotDraft: vi.fn(),
    buildDataSlotStructure: vi.fn(),
    upsertDataSlotDraft: vi.fn(),
  };
});

// Mock the authoring-routes scope loader; keep forkMeta real (pure function).
vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

// Mock the fork writer; the fork decides the editId.
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({
  forkVersionIfLaunched: vi.fn(),
}));

// Default-allow rate limiter; individual tests override to deny.
const rateLimitMock = vi.hoisted(() => ({
  dataSlotsGenerationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
  dataSlotsRefineLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
  dataSlotsAssignLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET, PUT } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/route';
import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/generate/route';
import { POST as POST_REFINE } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/refine/route';
import { POST as POST_ASSIGN } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/assign/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  loadDataSlots,
  loadDataSlotDraft,
  replaceDataSlots,
  deleteDataSlotDraft,
  buildDataSlotStructure,
  upsertDataSlotDraft,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const PARAMS = { id: 'qn-1', vid: 'ver-1' };

/** Wrap params in the Next.js route context shape the handlers receive. */
function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** Minimal JSON request. */
function jsonReq(body: unknown, url = 'http://localhost:3000/api/v1'): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

/** The version record the route reads (draft status by default). */
function scopedVersion(status: 'draft' | 'launched' | 'archived' = 'draft') {
  return { id: 'ver-1', questionnaireId: 'qn-1', versionNumber: 2, status };
}

/** A no-fork result for draft versions. */
function noForkResult() {
  return { versionId: 'ver-1', forked: false, versionNumber: 2 };
}

/** A fork result indicating a launched version was forked. */
function forkResult() {
  return { versionId: 'ver-2', forked: true, versionNumber: 3 };
}

/** Sample persisted data slot views. */
function sampleSlots() {
  return [
    {
      id: 'slot-1',
      key: 'personal_info',
      name: 'Personal Info',
      description: 'Basic details',
      theme: 'Background',
      ordinal: 0,
      weight: 1,
      questionKeys: ['full_name', 'email'],
    },
  ];
}

/** Sample draft view. */
function sampleDraft() {
  return {
    slots: [
      {
        name: 'Job Role',
        description: 'The respondent current role',
        theme: 'Career',
        questionKeys: ['role'],
        confidence: 0.85,
      },
    ],
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** A valid PUT body (replace slots). */
function validSlotsBody() {
  return {
    slots: [
      {
        name: 'Personal Info',
        description: 'Captures respondent identity details for segmentation.',
        theme: 'Background',
        questionKeys: ['full_name'],
      },
    ],
  };
}

/** A valid generate-data-slots dispatch success payload. */
function generateDispatchSuccess() {
  return {
    success: true,
    data: {
      slots: [
        {
          name: 'Job Role',
          description: 'The respondent current role in the organisation.',
          theme: 'Career',
          questionKeys: ['role'],
          confidence: 0.9,
        },
      ],
    },
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

// ─── beforeEach — happy-path defaults ────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Both flags on.
  vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
    Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG || flag === APP_QUESTIONNAIRES_DATA_SLOTS_FLAG)
  );

  setAuth(mockAdminUser());

  (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
  (loadDataSlots as Mock).mockResolvedValue(sampleSlots());
  (loadDataSlotDraft as Mock).mockResolvedValue(sampleDraft());
  (replaceDataSlots as Mock).mockResolvedValue(sampleSlots());
  (deleteDataSlotDraft as Mock).mockResolvedValue(undefined);
  (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());

  // Generate route defaults.
  prismaMock.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-1',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    fallbackProviders: [],
  });
  (buildDataSlotStructure as Mock).mockResolvedValue({
    goal: 'Understand onboarding',
    audience: { role: 'new hire' },
    questions: [
      { key: 'role', prompt: 'What is your role?', type: 'free_text', sectionTitle: 'Background' },
    ],
  });
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(generateDispatchSuccess());
  (upsertDataSlotDraft as Mock).mockResolvedValue(undefined);
  rateLimitMock.dataSlotsGenerationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  rateLimitMock.dataSlotsRefineLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
  rateLimitMock.dataSlotsAssignLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
});

// ─── GET — gate + auth ─────────────────────────────────────────────────────────

describe('GET …/data-slots — gate and auth', () => {
  it('returns 404 NOT_FOUND when the master questionnaires flag is off (gate runs before auth)', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // Gate short-circuits before any auth work.
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(loadDataSlots).not.toHaveBeenCalled();
  });

  it('returns 404 when master flag is on but data-slots sub-flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // withQuestionnairesEnabled passes, but isDataSlotsEnabled inside handler returns false.
    expect(loadDataSlots).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(loadDataSlots).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(loadDataSlots).not.toHaveBeenCalled();
  });

  it('returns 404 when the version does not resolve under the questionnaire', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(loadDataSlots).not.toHaveBeenCalled();
  });
});

// ─── GET — happy path ──────────────────────────────────────────────────────────

describe('GET …/data-slots — happy path', () => {
  it('returns 200 with slots array and the pending draft in the response envelope', async () => {
    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Route wraps loader output — assert structure, not raw mock echo.
    expect(body.data).toMatchObject({
      slots: sampleSlots(),
      draft: sampleDraft(),
    });
  });

  it('loads slots and draft in parallel for the scoped version id', async () => {
    await GET(jsonReq(null), ctx(PARAMS));

    // Both loaders should receive the version id from the route params.
    expect(loadDataSlots).toHaveBeenCalledWith('ver-1');
    expect(loadDataSlotDraft).toHaveBeenCalledWith('ver-1');
  });

  it('returns draft: null when no pending proposal exists for the version', async () => {
    (loadDataSlotDraft as Mock).mockResolvedValue(null);

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.draft).toBeNull();
    expect(body.data.slots).toEqual(sampleSlots());
  });

  it('returns an empty slots array when none have been saved yet', async () => {
    (loadDataSlots as Mock).mockResolvedValue([]);

    const res = await GET(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    expect((await res.json()).data.slots).toEqual([]);
  });
});

// ─── PUT — gate + auth ─────────────────────────────────────────────────────────

describe('PUT …/data-slots — gate and auth', () => {
  it('returns 404 when the questionnaire app is disabled (gate runs before auth)', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);

    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 404 when the data-slots sub-flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );

    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());

    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(401);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));

    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(403);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 404 when the version does not resolve under the questionnaire', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);

    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });
});

// ─── PUT — body validation ─────────────────────────────────────────────────────

describe('PUT …/data-slots — body validation', () => {
  it('returns 400 when the body is missing the slots array', async () => {
    const res = await PUT(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 400 when a slot has an empty name', async () => {
    const res = await PUT(
      jsonReq({
        slots: [
          {
            name: '',
            description: 'Valid description text here.',
            theme: 'Career',
            questionKeys: [],
          },
        ],
      }),
      ctx(PARAMS)
    );

    expect(res.status).toBe(400);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 400 when a slot name exceeds 4 words', async () => {
    const res = await PUT(
      jsonReq({
        slots: [
          {
            name: 'This Name Has Five Words',
            description: 'A valid description for this slot.',
            theme: 'Theme',
            questionKeys: [],
          },
        ],
      }),
      ctx(PARAMS)
    );

    expect(res.status).toBe(400);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 400 when the slots array exceeds 60 entries', async () => {
    const slot = {
      name: 'Role',
      description: 'A valid slot description for testing purposes.',
      theme: 'Background',
      questionKeys: [],
    };
    const res = await PUT(jsonReq({ slots: Array(61).fill(slot) }), ctx(PARAMS));

    expect(res.status).toBe(400);
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });
});

// ─── PUT — draft version (no fork) ────────────────────────────────────────────

describe('PUT …/data-slots — draft version (no fork)', () => {
  it('replaces slots and returns 200 with slots + fork meta (forked: false)', async () => {
    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Response envelope carries the replaced slot set — the route wraps replaceDataSlots output.
    expect(body.data.slots).toEqual(sampleSlots());
    // No fork occurred — meta reflects the original version.
    expect(body.meta).toMatchObject({ forked: false, versionId: 'ver-1' });
  });

  it('calls replaceDataSlots with the editId (same as vid when not forked)', async () => {
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(replaceDataSlots).toHaveBeenCalledWith(
      'ver-1', // editId = original vid when not forked
      expect.arrayContaining([expect.objectContaining({ name: 'Personal Info' })])
    );
  });

  it('does NOT call deleteDataSlotDraft on the source version when editId === vid', async () => {
    // Only retires the source draft when a fork happened (editId !== vid).
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(deleteDataSlotDraft).not.toHaveBeenCalled();
  });

  it('writes an admin audit row with the correct action and slot count', async () => {
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'questionnaire_data_slots.save',
        entityType: 'questionnaire_version',
        entityId: 'ver-1',
        clientIp: '203.0.113.7',
        metadata: expect.objectContaining({
          questionnaireId: 'qn-1',
          versionId: 'ver-1',
          slotCount: sampleSlots().length,
        }),
      })
    );
  });
});

// ─── PUT — launched version (fork path) ───────────────────────────────────────

describe('PUT …/data-slots — launched version (fork path)', () => {
  beforeEach(() => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());
  });

  it('forks the launched version and returns forked: true with the new versionId', async () => {
    const res = await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The response carries the NEW (forked) version id.
    expect(body.meta).toMatchObject({ forked: true, versionId: 'ver-2' });
  });

  it('writes slots to the forked version id (ver-2), not the original (ver-1)', async () => {
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(replaceDataSlots).toHaveBeenCalledWith('ver-2', expect.any(Array));
  });

  it('retires the source draft on the original version after a fork', async () => {
    // When editId !== vid, the route also calls deleteDataSlotDraft on the source version
    // to prevent orphaned proposals.
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(deleteDataSlotDraft).toHaveBeenCalledWith('ver-1');
  });

  it('writes an admin audit row keyed to the forked version id', async () => {
    await PUT(jsonReq(validSlotsBody()), ctx(PARAMS));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'ver-2',
        metadata: expect.objectContaining({
          versionId: 'ver-2',
          questionnaireId: 'qn-1',
        }),
      })
    );
  });
});

// ─── POST /generate — gate + auth ─────────────────────────────────────────────

describe('POST …/data-slots/generate — gate and auth', () => {
  it('returns 404 NOT_FOUND when the questionnaire app is disabled (gate runs before auth)', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when the data-slots sub-flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when the version has no questions (structure returns null)', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(null);

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when the generator agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── POST /generate — rate limit ──────────────────────────────────────────────

describe('POST …/data-slots/generate — rate limit', () => {
  it('returns 429 when the per-admin generation sub-cap is exceeded (before dispatch)', async () => {
    rateLimitMock.dataSlotsGenerationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(429);
    // Dispatch never runs when rate-limited.
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(buildDataSlotStructure).not.toHaveBeenCalled();
  });
});

// ─── POST /generate — happy path ──────────────────────────────────────────────

describe('POST …/data-slots/generate — happy path', () => {
  it('returns 200 with the generated slots in the standard envelope', async () => {
    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The route wraps dispatch output, not raw mock return.
    expect(body.data.slots).toHaveLength(1);
    expect(body.data.slots[0]).toMatchObject({
      name: 'Job Role',
      theme: 'Career',
      questionKeys: ['role'],
    });
  });

  it('dispatches with the correct capability slug and the version structure', async () => {
    await POST(jsonReq(null), ctx(PARAMS));

    const [slug, args, context] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe(GENERATE_DATA_SLOTS_CAPABILITY_SLUG);
    expect(args).toMatchObject({
      structure: expect.objectContaining({ questions: expect.any(Array) }),
      versionId: 'ver-1',
    });
    // Context carries the agent binding for provider selection.
    expect(context.agentId).toBe('agent-1');
    expect(context.entityContext.dataSlotsAgent).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
    });
  });

  it('persists the generated slots as the version draft when the slot set is non-empty', async () => {
    await POST(jsonReq(null), ctx(PARAMS));

    expect(upsertDataSlotDraft).toHaveBeenCalledWith('ver-1', expect.any(Array));
  });

  it('does NOT call upsertDataSlotDraft when the generator returns an empty slot set', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: { slots: [] },
    });

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    expect(upsertDataSlotDraft).not.toHaveBeenCalled();
    expect((await res.json()).data.slots).toEqual([]);
  });

  it('builds the structure scoped to the questionnaire id + version id pair', async () => {
    await POST(jsonReq(null), ctx(PARAMS));

    expect(buildDataSlotStructure).toHaveBeenCalledWith('qn-1', 'ver-1');
  });
});

// ─── POST /generate — fail-soft dispatch failures ─────────────────────────────

describe('POST …/data-slots/generate — fail-soft dispatch', () => {
  it('returns 200 with empty slots and a diagnostic when dispatch fails (not a 5xx)', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'generation_failed', message: 'LLM error' },
    });

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.slots).toEqual([]);
    // The diagnostic carries the capability error code AND its human message so the UI can surface it.
    expect(body.data.diagnostic).toBe('generation_failed');
    expect(body.data.diagnosticMessage).toBe('LLM error');
    // No draft persisted on failure.
    expect(upsertDataSlotDraft).not.toHaveBeenCalled();
  });

  it('reports generation_failed as the diagnostic when dispatch returns success:true with no data', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: undefined,
    });

    const res = await POST(jsonReq(null), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slots).toEqual([]);
    expect(body.data.diagnostic).toBe('generation_failed');
    expect(upsertDataSlotDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown_capability', 'unknown_capability'],
    ['rate_limited', 'rate_limited'],
    ['capability_quarantined', 'capability_quarantined'],
  ])(
    'surfaces dispatch error code "%s" in the diagnostic instead of 5xx-ing',
    async (capCode, expectedDiagnostic) => {
      dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
        success: false,
        error: { code: capCode, message: 'boom' },
      });

      const res = await POST(jsonReq(null), ctx(PARAMS));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.slots).toEqual([]);
      expect(body.data.diagnostic).toBe(expectedDiagnostic);
    }
  );
});

// ─── POST /refine — single-slot refinement ────────────────────────────────────

/** A valid refine request body. */
function refineReqBody() {
  return {
    instructions: 'Focus on enterprise buyers and fold in pricing.',
    slot: {
      name: 'Job Role',
      description: 'The respondent current role.',
      theme: 'Career',
      questionKeys: ['role'],
    },
  };
}

/** A valid refine dispatch success payload (one refined slot). */
function refineDispatchSuccess() {
  return {
    success: true,
    data: {
      slot: {
        name: 'Enterprise Role',
        description: 'The respondent role and buying authority in an enterprise context.',
        theme: 'Career',
        questionKeys: ['role'],
        confidence: 0.88,
      },
    },
  };
}

describe('POST …/data-slots/refine — gate and auth', () => {
  it('returns 404 when the data-slots sub-flag is off (before auth)', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin authenticated user', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(403);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the version has no questions', async () => {
    (buildDataSlotStructure as Mock).mockResolvedValue(null);
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when the master questionnaires flag is off (before auth)', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 404 when the refine agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('POST …/data-slots/refine — validation', () => {
  it('rejects an empty-instructions body with 400 before dispatching', async () => {
    const res = await POST_REFINE(
      jsonReq({ ...refineReqBody(), instructions: '   ' }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a missing slot with 400', async () => {
    const res = await POST_REFINE(jsonReq({ instructions: 'do it' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-JSON) body with 400 instead of throwing', async () => {
    const badReq = {
      url: 'http://localhost:3000/api/v1',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as NextRequest;
    const res = await POST_REFINE(badReq, ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('POST …/data-slots/refine — rate limit', () => {
  it('returns 429 when the refine sub-cap is exceeded', async () => {
    rateLimitMock.dataSlotsRefineLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000,
    });
    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('POST …/data-slots/refine — happy path', () => {
  it('returns 200 with the single refined slot and dispatches the refine capability', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(refineDispatchSuccess());

    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.slot.name).toBe('Enterprise Role');

    const [slug, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_refine_data_slot');
    expect(args).toEqual(
      expect.objectContaining({
        instructions: refineReqBody().instructions,
        versionId: PARAMS.vid,
        slot: expect.objectContaining({ name: 'Job Role' }),
      })
    );
  });

  it('forwards siblingSlots to the dispatched capability when present', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(refineDispatchSuccess());
    const siblingSlots = [{ name: 'Pricing', theme: 'Money' }];

    const res = await POST_REFINE(jsonReq({ ...refineReqBody(), siblingSlots }), ctx(PARAMS));

    expect(res.status).toBe(200);
    const [, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(args).toEqual(expect.objectContaining({ siblingSlots }));
  });

  it('persists nothing — refine is a client-only working-set edit', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(refineDispatchSuccess());
    await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));
    expect(upsertDataSlotDraft).not.toHaveBeenCalled();
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });
});

describe('POST …/data-slots/refine — fail-soft dispatch', () => {
  it('returns 200 with slot:null and a diagnostic when the refiner fails', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'provider offline' },
    });

    const res = await POST_REFINE(jsonReq(refineReqBody()), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.slot).toBeNull();
    expect(body.data.diagnostic).toBe('provider_unavailable');
    expect(body.data.diagnosticMessage).toBe('provider offline');
  });
});

// ─── POST …/data-slots/assign ──────────────────────────────────────────────────

/** A dispatch payload placing the orphan 'role' into the existing 'personal_info' slot. */
function assignDispatchSuccess() {
  return {
    success: true,
    data: {
      placements: [{ questionKey: 'role', target: { kind: 'existing', slotKey: 'personal_info' } }],
    },
  };
}

describe('POST …/data-slots/assign — happy path', () => {
  beforeEach(() => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(assignDispatchSuccess());
  });

  it('assigns the orphaned question and writes the merged set live', async () => {
    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.assigned).toBe(1);

    // The deterministic merge ran (real) and the result was persisted via replaceDataSlots, with the
    // orphan 'role' folded into the existing 'personal_info' slot's question keys.
    expect(replaceDataSlots).toHaveBeenCalledTimes(1);
    const [, merged] = (replaceDataSlots as Mock).mock.calls[0];
    const personal = merged.find((s: { name: string }) => s.name === 'Personal Info');
    expect(personal.questionKeys).toContain('role');

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_data_slots.assign' })
    );
  });

  it('restricts to the requested question keys', async () => {
    await POST_ASSIGN(jsonReq({ questionKeys: ['role'] }), ctx(PARAMS));
    const [, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(args.orphanQuestionKeys).toEqual(['role']);
  });
});

describe('POST …/data-slots/assign — nothing to do', () => {
  it('returns assigned:0 without dispatching when no questions are orphaned', async () => {
    // Every question is already covered by an existing slot.
    (buildDataSlotStructure as Mock).mockResolvedValue({
      goal: 'g',
      questions: [
        { key: 'full_name', prompt: 'Name?', type: 'free_text', sectionTitle: 'Background' },
      ],
    });

    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assigned).toBe(0);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });
});

describe('POST …/data-slots/assign — fork + fail-soft + rate limit', () => {
  it('forks a launched version and assigns on the new draft', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(assignDispatchSuccess());

    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.forked).toBe(true);
    expect(body.meta.versionId).toBe('ver-2');
  });

  it('returns 200 with a diagnostic and writes nothing when the assigner fails', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'provider offline' },
    });

    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assigned).toBe(0);
    expect(body.data.diagnostic).toBe('provider_unavailable');
    expect(replaceDataSlots).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-admin assign rate limit is exceeded', async () => {
    rateLimitMock.dataSlotsAssignLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Date.now() + 1000,
    });

    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(429);
  });

  it('returns 404 when the data-slots sub-flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
      Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
    );

    const res = await POST_ASSIGN(jsonReq({}), ctx(PARAMS));

    expect(res.status).toBe(404);
  });
});
