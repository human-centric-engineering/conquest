/**
 * Integration test: questionnaire next-question preview route (F4.1 / PR2).
 *
 * Exercises the POST handler with the DB seam (`prisma`) mocked: gate order
 * (401 unauthenticated; 403 non-admin), scope-404, body validation, and the
 * selection wiring for each deterministic strategy — sequential (the saved
 * default), answered-state filtering, a `weighted` override, `random`
 * determinism, the `adaptive`-degrades-to-weighted PR2 behaviour, and the
 * terminal `complete` decision. The strategy algorithms themselves are
 * unit-tested separately; this pins the route → context-builder → registry wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Adaptive's real deps (embedder + LLM) are mocked so the route's adaptive path
// can be exercised without I/O.
vi.mock('@/app/api/v1/app/questionnaires/_lib/adaptive-deps', () => ({
  buildAdaptiveDeps: vi.fn(),
}));

// The adaptive sub-cap is a module-singleton sliding-window limiter. Mock it so
// tests don't consume real tokens (no cross-test window-state leak) and so the
// 429 path is drivable. Default: allow; a test overrides per-call to deny.
const rateLimitMock = vi.hoisted(() => ({
  adaptiveSelectionLimiter: {
    check: vi.fn(() => ({ success: true, limit: 30, remaining: 29, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/next-question/route';

import { auth } from '@/lib/auth/config';
import { buildAdaptiveDeps } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/next-question';

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

/**
 * A version with one section holding two optional questions: q1 (weight 1,
 * first) and q2 (weight 5, second). Sequential prefers q1; weighted prefers q2.
 * `config: null` → the lazy default (now `adaptive`, coverage 1, min 0).
 */
function versionRow(config: Record<string, unknown> | null = null) {
  return {
    id: 'v1',
    config,
    sections: [
      {
        id: 's1',
        ordinal: 0,
        questions: [
          {
            id: 'q1-id',
            key: 'q1',
            ordinal: 0,
            weight: 1,
            required: false,
            type: 'free_text',
            prompt: 'What is your name?',
            tags: [],
          },
          {
            id: 'q2-id',
            key: 'q2',
            ordinal: 1,
            weight: 5,
            required: false,
            type: 'free_text',
            prompt: 'Describe your goals.',
            tags: [],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req({}), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req({}), ctx(PARAMS));
    expect(res.status).toBe(404);
    // Error responses follow the standard envelope.
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  });
});

describe('body validation', () => {
  it('rejects an out-of-range confidence', async () => {
    const res = await POST(req({ answered: [{ key: 'q1', confidence: 2 }] }), ctx(PARAMS));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toEqual(expect.any(String));
  });

  it('rejects an unknown strategy override', async () => {
    const res = await POST(req({ strategyOverride: 'telepathic' }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });
});

describe('selection wiring', () => {
  it('uses the saved (sequential) strategy and asks the first question', async () => {
    // The app default is now `adaptive`; save an explicit sequential config so this pins the
    // sequential wiring deterministically (without depending on adaptive's mocked LLM deps).
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(
      versionRow({
        selectionStrategy: 'sequential',
        minQuestionsAnswered: 0,
        coverageThreshold: 1,
        costBudgetUsd: null,
        maxQuestionsPerSession: null,
        voiceEnabled: false,
        contradictionMode: 'off',
        contradictionWindowN: 0,
        anonymousMode: false,
        profileFields: [],
      })
    );
    const res = await POST(req({ answered: [] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.strategy).toBe('sequential');
    expect(body.data.decision).toMatchObject({ kind: 'ask', questionId: 'q1-id' });
    expect(body.data.question).toMatchObject({ key: 'q1', prompt: 'What is your name?' });
  });

  it('skips answered questions (addressed by key)', async () => {
    const res = await POST(req({ answered: [{ key: 'q1' }] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.decision).toMatchObject({ kind: 'ask', questionId: 'q2-id' });
  });

  it('honours a weighted strategy override (picks the heavier question)', async () => {
    const res = await POST(req({ strategyOverride: 'weighted', answered: [] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.strategy).toBe('weighted');
    expect(body.data.decision).toMatchObject({ kind: 'ask', questionId: 'q2-id' });
  });

  it('is deterministic for random given a fixed sessionId', async () => {
    const payload = { strategyOverride: 'random', sessionId: 'sess-fixed', answered: [] };
    const first = await (await POST(req(payload), ctx(PARAMS))).json();
    const second = await (await POST(req(payload), ctx(PARAMS))).json();
    expect(first.data.decision).toEqual(second.data.decision);
    expect(first.data.decision.kind).toBe('ask');
  });

  it('returns a terminal complete decision once everything is answered', async () => {
    const res = await POST(req({ answered: [{ key: 'q1' }, { key: 'q2' }] }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.decision.kind).toBe('complete');
    expect(body.data.question).toBeUndefined();
  });

  it('resolves the saved config strategy when no override is given', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(
      versionRow({
        selectionStrategy: 'weighted',
        minQuestionsAnswered: 0,
        coverageThreshold: 1,
        costBudgetUsd: null,
        maxQuestionsPerSession: null,
        voiceEnabled: false,
        contradictionMode: 'off',
        contradictionWindowN: 0,
        anonymousMode: false,
        profileFields: [],
      })
    );
    const res = await POST(req({ answered: [] }), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.strategy).toBe('weighted');
    expect(body.data.decision.questionId).toBe('q2-id');
  });
});

describe('adaptive path', () => {
  beforeEach(() => {
    // A controllable fake of the real embedder/LLM deps.
    (buildAdaptiveDeps as unknown as Mock).mockReturnValue({
      embedText: vi.fn(async () => [0.1, 0.2]),
      rankByVector: vi.fn(async (_e: number[], ids: string[], k: number) => ids.slice(0, k)),
      llmPick: vi.fn(async () => ({
        questionId: 'q1-id',
        rationale: 'adaptive chose q1',
        costUsd: 0.005,
      })),
    });
  });

  it('wires the adaptive deps and returns the LLM-chosen question', async () => {
    const res = await POST(
      req({ strategyOverride: 'adaptive', recentMessages: ['I just moved'], answered: [] }),
      ctx(PARAMS)
    );
    const body = await res.json();
    expect(body.data.strategy).toBe('adaptive');
    expect(body.data.decision).toMatchObject({
      kind: 'ask',
      questionId: 'q1-id',
      costUsd: 0.005,
    });
    expect(body.data.decision.rationale).toBe('adaptive chose q1');
    expect(buildAdaptiveDeps).toHaveBeenCalledWith({ userId: expect.any(String) });
  });

  it('still degrades to weighted when there is no conversation history', async () => {
    const res = await POST(req({ strategyOverride: 'adaptive', answered: [] }), ctx(PARAMS));
    const body = await res.json();
    // Deps are wired, but the strategy's own fallback fires (no recentMessages).
    expect(body.data.decision.kind).toBe('ask');
    expect(body.data.decision.rationale).toMatch(/fell back to weighted/i);
  });

  it('429s when the adaptive sub-cap is exceeded, before building deps', async () => {
    rateLimitMock.adaptiveSelectionLimiter.check.mockReturnValueOnce({
      success: false,
      limit: 30,
      remaining: 0,
      reset: 1_700_000_000_000,
    });
    const res = await POST(
      req({ strategyOverride: 'adaptive', recentMessages: ['hi'], answered: [] }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(429);
    // The sub-cap gates the spend — deps are never built.
    expect(buildAdaptiveDeps).not.toHaveBeenCalled();
  });
});
