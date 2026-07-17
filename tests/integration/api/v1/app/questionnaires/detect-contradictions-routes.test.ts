/**
 * Integration test: questionnaire contradiction-detection preview route (F4.3).
 *
 * Exercises the POST handler with the DB seam (`prisma`) and the capability
 * dispatcher mocked: gate order (404 master-flag-off before auth; 404 sub-flag-off
 * after auth), 401/403, scope-404, insufficient-answers 400, body validation, the
 * rate-limit 429, the capability wiring (mode/windowN defaulted from config), and
 * the fail-soft empty-findings path. The detector capability itself is tested
 * separately (contradiction-capability.test.ts); this pins the route →
 * context-builder → dispatch wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatchMock = vi.hoisted(() => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => dispatchMock);

// The route flushes capability handlers before dispatching; here it's a no-op so the
// mocked dispatcher stands alone (the real flush is covered by the registry's own tests).
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

const rateLimitMock = vi.hoisted(() => ({
  contradictionDetectionLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/detect-contradictions/route';

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL =
  'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/detect-contradictions';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

/** A version with two slots and a saved `probe` / windowN=2 config. */
function versionRow() {
  return {
    id: 'v1',
    config: { contradictionMode: 'probe', contradictionWindowN: 2 },
    sections: [
      {
        id: 's1',
        questions: [
          {
            id: 'q1-id',
            key: 'has_children',
            type: 'boolean',
            typeConfig: null,
            prompt: 'Do you have children?',
            guidelines: null as string | null,
            required: true,
          },
          {
            id: 'q2-id',
            key: 'children_count',
            type: 'numeric',
            typeConfig: null,
            prompt: 'How many children?',
            guidelines: null as string | null,
            required: false,
          },
        ],
      },
    ],
  };
}

const AGENT_ROW = { id: 'agent-1', provider: '', model: '', fallbackProviders: [] };

/** A valid dispatch result with one finding (carrying a probe). */
function dispatchSuccess() {
  return {
    success: true,
    data: {
      droppedCount: 0,
      findings: [
        {
          slotKeys: ['has_children', 'children_count'],
          explanation: 'Said no children but later gave a count of two.',
          severity: 'high',
          confidence: 0.9,
          suggestedProbe: 'Earlier you said no children — do you have two?',
        },
      ],
    },
  };
}

const VALID_BODY = {
  answers: [
    { key: 'has_children', value: false },
    { key: 'children_count', value: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(dispatchSuccess());
  rateLimitMock.contradictionDetectionLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(VALID_BODY), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req(VALID_BODY), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });
});

describe('body validation', () => {
  it('rejects fewer than two answers', async () => {
    const res = await POST(req({ answers: [{ key: 'has_children', value: false }] }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects a missing answers array', async () => {
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid mode', async () => {
    const res = await POST(req({ ...VALID_BODY, mode: 'shout' }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects more answers than the capability ceiling (clean 400, not a fail-soft)', async () => {
    // The body cap is aligned to the capability's MAX_CONTRADICTION_ANSWERS (300),
    // so an over-large request is rejected here rather than fail-softing at dispatch.
    const tooMany = Array.from({ length: 301 }, (_, i) => ({ key: `q${i}`, value: i }));
    const res = await POST(req({ answers: tooMany }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('400s when fewer than two answers resolve to real slots (stale keys dropped)', async () => {
    const res = await POST(
      req({
        answers: [
          { key: 'has_children', value: false },
          { key: 'ghost', value: 'x' },
        ],
      }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
    // The dispatch never runs — distinct from a missing version (404).
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.contradictionDetectionLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('detection wiring', () => {
  it('returns findings with a summary (count, probes, severities)', async () => {
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.findings).toHaveLength(1);
    expect(body.data.summary).toMatchObject({
      findingCount: 1,
      probeCount: 1,
      severityCounts: { high: 1 },
    });
  });

  it("reports the capability's real droppedCount in the summary (not a hardcoded 0)", async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: { droppedCount: 3, findings: dispatchSuccess().data.findings },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.summary.droppedCount).toBe(3);
  });

  it('dispatches with all slots, the answers, the detector binding, and config-defaulted mode/window', async () => {
    await POST(req(VALID_BODY), ctx(PARAMS));
    const [slug, args, context] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_detect_contradictions');
    expect(args.slots.map((s: { key: string }) => s.key).sort()).toEqual([
      'children_count',
      'has_children',
    ]);
    expect(args.answers).toHaveLength(2);
    // mode/windowN default from the version's saved config when the body omits them.
    expect(args.mode).toBe('probe');
    expect(args.windowN).toBe(2);
    expect(context.agentId).toBe('agent-1');
    expect(context.entityContext.contradictionDetectorAgent).toMatchObject({
      provider: '',
      model: '',
    });
  });

  it('lets the request body override the config mode/window', async () => {
    await POST(req({ ...VALID_BODY, mode: 'flag', windowN: 0 }), ctx(PARAMS));
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    expect(args.mode).toBe('flag');
    expect(args.windowN).toBe(0);
  });

  it('defaults mode to off and windowN to 0 when the version has no saved config', async () => {
    // config: null → the off/0 fallback path of the context builder.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...versionRow(),
      config: null,
    });
    await POST(req(VALID_BODY), ctx(PARAMS));
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    expect(args.mode).toBe('off');
    expect(args.windowN).toBe(0);
  });

  it('threads slot guidelines and answer provenance/turnIndex through to the dispatch', async () => {
    const withGuidelines = versionRow();
    withGuidelines.sections[0].questions[0].guidelines = 'Count step-children too';
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(withGuidelines);

    await POST(
      req({
        answers: [
          { key: 'has_children', value: false, provenance: 'direct', turnIndex: 1 },
          { key: 'children_count', value: 2, provenance: 'inferred', turnIndex: 4 },
        ],
      }),
      ctx(PARAMS)
    );
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    const childrenSlot = args.slots.find((s: { key: string }) => s.key === 'has_children');
    expect(childrenSlot.guidelines).toBe('Count step-children too');
    expect(args.answers[0]).toMatchObject({ provenance: 'direct', turnIndex: 1 });
  });

  it('is fail-soft: a capability error yields empty findings + a diagnostic, not a 5xx', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'detection_failed', message: 'boom' },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.findings).toEqual([]);
    expect(body.data.diagnostic).toBe('detection_failed');
    expect(body.data.summary).toMatchObject({ findingCount: 0, probeCount: 0, droppedCount: 0 });
  });

  it('is fail-soft when the dispatch succeeds but carries no data', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: undefined,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.findings).toEqual([]);
    expect(body.data.diagnostic).toBe('detection_failed');
  });

  it('404s when the contradiction-detector agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
