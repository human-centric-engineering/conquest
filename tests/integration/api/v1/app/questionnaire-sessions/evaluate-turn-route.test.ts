/**
 * Integration test: turn-evaluation route.
 *
 * Exercises the POST handler with the DB seam (`prisma`), the evaluator service, and the rate
 * limiter mocked: gate order (404 when the flag is off, before auth), 401/403, preview-only
 * (404 for a missing or non-preview session), not-configured-404 (no evaluator agent seeded),
 * the rate-limit 429, invalid-body 400, the fail-soft 502 when the evaluator throws, and the
 * happy path. The service itself is tested separately (evaluate-turn.test.ts); this pins the
 * route → load → dispatch wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
  aiAgent: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const evalMock = vi.hoisted(() => ({ evaluateTurn: vi.fn() }));
vi.mock('@/lib/app/questionnaire/turn-evaluation', () => ({
  evaluateTurn: evalMock.evaluateTurn,
  MAX_EVALUATED_CALLS: 40,
}));

const rateLimitMock = vi.hoisted(() => ({
  turnEvaluationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateLimitMock);

const storeMock = vi.hoisted(() => ({ persistTurnEvaluation: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store', () => storeMock);

// ─── Imports (after mocks) ──────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/evaluate-turn/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const ROUTE_URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/evaluate-turn';

const TURN = {
  turnIndex: 0,
  calls: [
    {
      label: 'Answer extraction',
      model: 'gpt-4o-mini',
      provider: 'openai',
      latencyMs: 400,
      costUsd: 0.001,
      prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
      response: '{"intents":[{"slotKey":"housing"}]}',
    },
  ],
};

function req(body: unknown): NextRequest {
  return {
    url: ROUTE_URL,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

function previewSession() {
  return {
    isPreview: true,
    version: {
      id: 'ver-1',
      goal: 'Understand housing security',
      audience: { role: 'Renter' },
      config: { selectionStrategy: 'adaptive', tone: { persona: 'warm' } },
    },
  };
}

function evaluatorAgent() {
  return { id: 'agent-eval', provider: '', model: '', fallbackProviders: [] };
}

const VERDICT_RESULT = {
  verdict: { overallScore: 82, effectiveness: 'Good' },
  costUsd: 0.004,
  model: 'claude-x',
  provider: 'anthropic',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Flags on by default (both master + sub resolve true).
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(previewSession());
  prismaMock.aiAgent.findFirst.mockResolvedValue(evaluatorAgent());
  evalMock.evaluateTurn.mockResolvedValue(VERDICT_RESULT);
  storeMock.persistTurnEvaluation.mockResolvedValue({
    id: 'eval-1',
    turnId: 'turn-1',
    turnOrdinal: 1,
    rubricVersion: '1.0.0',
    appVersion: '0.0.0',
    createdAt: new Date('2026-06-17T00:00:00Z'),
  });
  rateLimitMock.turnEvaluationLimiter.check.mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
});

describe('POST evaluate-turn', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    setAuth(null); // auth must not be reached

    const res = await POST(req({ turn: TURN }), ctx('sess-1'));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } });
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated (flag on)', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(401);
  });

  it('403s for an authenticated non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(403);
  });

  it('404s when the session is missing', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(404);
  });

  it('404s when the session is not a preview', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue({
      ...previewSession(),
      isPreview: false,
    });
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(404);
    expect(evalMock.evaluateTurn).not.toHaveBeenCalled();
  });

  it('404s when the evaluator agent is not seeded', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(null);
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(404);
  });

  it('429s when the per-admin sub-cap is exceeded', async () => {
    rateLimitMock.turnEvaluationLimiter.check.mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 9_999_999_999,
    });
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(429);
    expect(evalMock.evaluateTurn).not.toHaveBeenCalled();
  });

  it('400s on an invalid body (empty calls array)', async () => {
    const res = await POST(req({ turn: { turnIndex: 0, calls: [] } }), ctx('sess-1'));
    expect(res.status).toBe(400);
  });

  it('502s (fail-soft) with the error envelope when the evaluator throws', async () => {
    evalMock.evaluateTurn.mockRejectedValue(new Error('provider down'));
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('evaluation_failed');
  });

  it('returns the verdict + evaluationId on the happy path, threading server-loaded context', async () => {
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.verdict.overallScore).toBe(82);
    expect(json.data.model).toBe('claude-x');
    expect(json.data.evaluationId).toBe('eval-1');

    // The route loaded the questionnaire objectives server-side and passed them through.
    const [input, agent, opts] = evalMock.evaluateTurn.mock.calls[0];
    expect(input.turn.turnIndex).toBe(0);
    expect(input.context).toMatchObject({
      goal: 'Understand housing security',
      // audience is summarised server-side to a bounded JSON string, not passed through raw.
      audience: '{"role":"Renter"}',
      selectionStrategy: 'adaptive',
      tone: 'warm',
    });
    expect(agent).toMatchObject({ provider: '', model: '' });
    expect(opts).toMatchObject({ agentId: 'agent-eval', sessionId: 'sess-1' });
  });

  it('persists the verdict with the snapshot, version id, evaluator binding, and admin id', async () => {
    await POST(req({ turn: TURN }), ctx('sess-1'));

    expect(storeMock.persistTurnEvaluation).toHaveBeenCalledTimes(1);
    const [params] = storeMock.persistTurnEvaluation.mock.calls[0];
    expect(params).toMatchObject({
      sessionId: 'sess-1',
      questionnaireVersionId: 'ver-1',
      verdict: { overallScore: 82, effectiveness: 'Good' },
      evaluatorModel: 'claude-x',
      evaluatorProvider: 'anthropic',
      evaluatorAgentId: 'agent-eval',
      costUsd: 0.004,
      evaluatedByUserId: mockAdminUser().user.id,
    });
    // The exact input that was judged is snapshotted (inspector data is otherwise live-only).
    expect(params.evaluatedInput.turn.turnIndex).toBe(0);
  });

  it('still returns the verdict with a null evaluationId when persistence fails', async () => {
    storeMock.persistTurnEvaluation.mockRejectedValue(new Error('db down'));
    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.verdict.overallScore).toBe(82);
    expect(json.data.evaluationId).toBeNull();
  });

  it('threads the client-supplied conversation messages into the context', async () => {
    const body = {
      turn: TURN,
      respondentMessage: 'I rent a flat',
      interviewerMessage: 'And whereabouts is that?',
      recentMessages: ['Hi', 'Tell me about your home'],
    };
    const res = await POST(req(body), ctx('sess-1'));
    expect(res.status).toBe(200);

    const [input] = evalMock.evaluateTurn.mock.calls[0];
    expect(input.context).toMatchObject({
      respondentMessage: 'I rent a flat',
      interviewerMessage: 'And whereabouts is that?',
      recentMessages: ['Hi', 'Tell me about your home'],
    });
  });

  it('omits absent objectives when the version has no goal/audience/config', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue({
      isPreview: true,
      version: { id: 'ver-1', goal: null, audience: null, config: null },
    });

    const res = await POST(req({ turn: TURN }), ctx('sess-1'));
    expect(res.status).toBe(200);

    const [input] = evalMock.evaluateTurn.mock.calls[0];
    // Absent objectives are omitted, not passed as null/undefined.
    expect(input.context).not.toHaveProperty('goal');
    expect(input.context).not.toHaveProperty('audience');
    expect(input.context).not.toHaveProperty('selectionStrategy');
    expect(input.context).not.toHaveProperty('tone');
  });
});
