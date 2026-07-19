/**
 * Integration test: questionnaire answer-refinement route (F4.4).
 *
 * Exercises the POST handler with the DB seam (`prisma`), the capability dispatcher,
 * and the answer-slot persistence seam (`_lib/answer-slots`) mocked — but the pure
 * `applyRefinement` REAL, so the persist payload is the genuine merge. Covers: gate
 * order (401 unauthenticated; 403 non-admin), scope-404, no-resolvable-answers 400,
 * body validation, the rate-limit 429, the
 * persist-then-refine wiring (seed → dispatch → apply → write), and the fail-soft
 * empty path. The refiner capability itself is tested separately.
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
  answerRefinementLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

const answerSlotsMock = vi.hoisted(() => ({
  getOrCreatePreviewSession: vi.fn(),
  upsertAnswerSlot: vi.fn(),
  loadAnswerSlot: vi.fn(),
  persistRefinement: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/answer-slots', () => answerSlotsMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/refine-answer/route';

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/refine-answer';

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

/** A version with a single_choice slot and a free_text slot. */
function versionRow() {
  return {
    id: 'v1',
    sections: [
      {
        id: 's1',
        questions: [
          {
            id: 'q-color',
            key: 'color',
            type: 'single_choice',
            typeConfig: { choices: [{ value: 'red' }, { value: 'green' }, { value: 'blue' }] },
            prompt: 'Favourite colour?',
            guidelines: null as string | null,
            required: false,
          },
          {
            id: 'q-mood',
            key: 'mood',
            type: 'free_text',
            typeConfig: null,
            prompt: 'How do you feel?',
            guidelines: null as string | null,
            required: false,
          },
        ],
      },
    ],
  };
}

const AGENT_ROW = { id: 'agent-1', provider: '', model: '', fallbackProviders: [] };

/** A dispatch result that refines colour red → green. */
function dispatchSuccess() {
  return {
    success: true,
    data: {
      droppedCount: 0,
      decisions: [
        {
          slotKey: 'color',
          action: 'refine',
          questionType: 'single_choice',
          newValue: 'green',
          rationale: 'they reconsidered',
          source: 'clarification',
          confidence: 0.9,
        },
      ],
    },
  };
}

const VALID_BODY = {
  existingAnswers: [
    { key: 'color', value: 'red', provenance: 'direct' },
    { key: 'mood', value: 'happy', provenance: 'direct' },
  ],
  userMessage: 'actually I prefer green now',
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(dispatchSuccess());
  rateLimitMock.answerRefinementLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
  answerSlotsMock.getOrCreatePreviewSession.mockResolvedValue('sess-preview');
  answerSlotsMock.upsertAnswerSlot.mockResolvedValue('ans-x');
  answerSlotsMock.loadAnswerSlot.mockResolvedValue({
    id: 'ans-color',
    existing: { slotKey: 'color', value: 'red', provenance: 'direct', refinementHistory: [] },
  });
  answerSlotsMock.persistRefinement.mockResolvedValue(undefined);
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
  it('rejects an empty existingAnswers array', async () => {
    const res = await POST(req({ existingAnswers: [] }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects a missing existingAnswers array', async () => {
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects an answer missing its provenance', async () => {
    const res = await POST(req({ existingAnswers: [{ key: 'color', value: 'red' }] }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects more answers than the capability ceiling (clean 400, not a fail-soft)', async () => {
    const tooMany = Array.from({ length: 301 }, (_, i) => ({
      key: `q${i}`,
      value: i,
      provenance: 'direct' as const,
    }));
    const res = await POST(req({ existingAnswers: tooMany }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('400s when no answer resolves to a real slot (stale keys dropped)', async () => {
    const res = await POST(
      req({ existingAnswers: [{ key: 'ghost', value: 'x', provenance: 'direct' }] }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.answerRefinementLimiter.check.mockReturnValue({
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

describe('refinement wiring + persistence', () => {
  it('dispatches with all slots, the existing answers, the refiner binding, and the preview session id', async () => {
    await POST(req(VALID_BODY), ctx(PARAMS));
    const [slug, args, context] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_refine_answer');
    expect(args.slots.map((s: { key: string }) => s.key).sort()).toEqual(['color', 'mood']);
    expect(args.existingAnswers).toHaveLength(2);
    expect(args.sessionId).toBe('sess-preview');
    expect(args.userMessage).toBe('actually I prefer green now');
    expect(context.agentId).toBe('agent-1');
    expect(context.entityContext.answerRefinerAgent).toMatchObject({ provider: '', model: '' });
  });

  it('seeds the supplied answers, then applies + persists each decision (real applyRefinement)', async () => {
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Both supplied answers seeded into the preview session.
    expect(answerSlotsMock.getOrCreatePreviewSession).toHaveBeenCalledWith('v1');
    expect(answerSlotsMock.upsertAnswerSlot).toHaveBeenCalledTimes(2);

    // The refine decision was applied (red → green, provenance refined) and persisted.
    expect(answerSlotsMock.persistRefinement).toHaveBeenCalledTimes(1);
    const [rowId, refined] = answerSlotsMock.persistRefinement.mock.calls[0];
    expect(rowId).toBe('ans-color');
    expect(refined.value).toBe('green');
    expect(refined.provenance).toBe('refined');
    expect(refined.refinementHistory).toHaveLength(1);

    // Response surfaces the decisions, the persisted slots, and a counts summary.
    expect(body.data.decisions).toHaveLength(1);
    expect(body.data.persistedSlots).toEqual([
      { slotKey: 'color', value: 'green', provenance: 'refined', action: 'refine' },
    ]);
    expect(body.data.summary).toMatchObject({ refineCount: 1, overwriteCount: 0, droppedCount: 0 });
  });

  it('threads full answer metadata and a triggering contradiction through to the dispatch', async () => {
    await POST(
      req({
        existingAnswers: [
          {
            key: 'color',
            value: 'red',
            provenance: 'inferred',
            rationale: 'guessed',
            confidence: 0.6,
            turnIndex: 2,
          },
        ],
        triggeringContradiction: {
          slotKeys: ['color', 'mood'],
          explanation: 'red vs cheerful',
          suggestedProbe: 'is red still right?',
        },
      }),
      ctx(PARAMS)
    );
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    expect(args.existingAnswers[0]).toMatchObject({
      slotKey: 'color',
      provenance: 'inferred',
      rationale: 'guessed',
      confidence: 0.6,
      turnIndex: 2,
    });
    expect(args.triggeringContradiction).toMatchObject({ explanation: 'red vs cheerful' });
    // userMessage omitted from the body → omitted from the dispatch args.
    expect(args.userMessage).toBeUndefined();
  });

  it("reports the capability's real droppedCount in the summary", async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: { droppedCount: 2, decisions: dispatchSuccess().data.decisions },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.summary.droppedCount).toBe(2);
  });

  it('skips persistence for a decision whose slot has no loaded answer', async () => {
    answerSlotsMock.loadAnswerSlot.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(answerSlotsMock.persistRefinement).not.toHaveBeenCalled();
    expect(body.data.persistedSlots).toEqual([]);
    // The decision is still surfaced even though it wasn't persisted.
    expect(body.data.decisions).toHaveLength(1);
  });

  it('is fail-soft: a capability error yields empty decisions + a diagnostic, not a 5xx', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'refinement_failed', message: 'boom' },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.decisions).toEqual([]);
    expect(body.data.persistedSlots).toEqual([]);
    expect(body.data.diagnostic).toBe('refinement_failed');
    expect(answerSlotsMock.persistRefinement).not.toHaveBeenCalled();
  });

  it('is fail-soft when the dispatch succeeds but carries no data', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: undefined,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect((await res.json()).data.diagnostic).toBe('refinement_failed');
  });

  it('404s when the answer-refiner agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
