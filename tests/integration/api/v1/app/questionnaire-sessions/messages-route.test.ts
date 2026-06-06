/**
 * Integration test: live respondent turn (SSE) route (F6.1, PR4).
 *
 * The turn-context loader, invoker builder, offer renderer, and persistence are mocked, but
 * the REAL pure orchestrator runs — so this pins the route's wiring: gate order
 * (flag → auth → ownership → status → sub-cap → validation), the SSE framing
 * (start → content → done), and that the turn is persisted with the orchestrator's outputs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const rateMock = vi.hoisted(() => ({ turnLimiter: { check: vi.fn() } }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit', () => rateMock);

const ctxMock = vi.hoisted(() => ({ buildTurnContext: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turn-context', () => ctxMock);

const invokersMock = vi.hoisted(() => ({ buildTurnInvokers: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers', () => invokersMock);

const runMock = vi.hoisted(() => ({ persistTurn: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-run', () => runMock);

const offerMock = vi.hoisted(() => ({ streamOfferMessage: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/offer-stream', () => offerMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/messages/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/messages';

function req(body: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(),
    signal: undefined,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

/** A loaded turn context whose only question is a single deterministic prompt. */
function loadedContext(over: Record<string, unknown> = {}) {
  return {
    session: { id: 'sess-1', status: 'active', versionId: 'v1', respondentUserId: USER },
    base: {
      sessionId: 'sess-1',
      config: {
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
      },
      questions: [
        {
          id: 'q1',
          key: 'q1',
          sectionId: 's1',
          sectionOrdinal: 0,
          ordinal: 0,
          weight: 1,
          required: false,
          type: 'free_text',
          tagIds: [],
          prompt: 'What is your role?',
        },
      ],
      answered: [],
      existingAnswers: [],
      recentMessages: [],
      selectionRound: 0,
    },
    slots: [
      {
        id: 'q1',
        key: 'q1',
        sectionId: 's1',
        prompt: 'What is your role?',
        type: 'free_text',
        required: false,
      },
    ],
    activeQuestionKey: null,
    byId: new Map(),
    ...over,
  };
}

/** Stub invokers: extraction/detection/refinement empty; selection asks q1. */
function stubInvokers() {
  return {
    extractAnswers: vi.fn(async () => ({ intents: [], costUsd: 0 })),
    detectContradictions: vi.fn(async () => ({ findings: [], costUsd: 0 })),
    refineAnswer: vi.fn(async () => ({ decisions: [], costUsd: 0 })),
    selectNext: vi.fn(async () => ({
      decision: { kind: 'ask', questionId: 'q1', rationale: 'first', costUsd: 0 },
    })),
  };
}

/** Drain an SSE Response body into an ordered list of { event, data }. */
async function drainSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const out: Array<{ event: string; data: unknown }> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  for (const frame of buffer.split('\n\n')) {
    const lines = frame.split('\n');
    const ev = lines
      .find((l) => l.startsWith('event:'))
      ?.slice(6)
      .trim();
    const dataLine = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!ev) continue;
    out.push({ event: ev, data: dataLine ? JSON.parse(dataLine) : null });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true); // master + all sub-flags on
  setAuth(mockAuthenticatedUser());
  rateMock.turnLimiter.check.mockReturnValue({ success: true });
  ctxMock.buildTurnContext.mockResolvedValue(loadedContext());
  invokersMock.buildTurnInvokers.mockResolvedValue(stubInvokers());
  runMock.persistTurn.mockResolvedValue('turn-1');
  offerMock.streamOfferMessage.mockImplementation(async function* () {
    yield { type: 'content', delta: 'Ready to submit?' };
    return { message: 'Ready to submit?', costUsd: 0.001 };
  });
});

describe('gate order', () => {
  it('404s when the live-sessions flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(401);
  });

  it('404s when the session does not exist', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(null);
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(404);
  });

  it('403s when the session belongs to another respondent', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: {
          id: 'sess-1',
          status: 'active',
          versionId: 'v1',
          respondentUserId: 'someone-else',
        },
      })
    );
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(403);
  });

  it('409s when the session is not active', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: { id: 'sess-1', status: 'paused', versionId: 'v1', respondentUserId: USER },
      })
    );
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(409);
  });

  it('429s when the per-turn sub-cap is exceeded', async () => {
    rateMock.turnLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: 0,
    });
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(429);
  });

  it('400s on an empty message', async () => {
    const res = await POST(req({ message: '' }), ctx);
    expect(res.status).toBe(400);
  });
});

describe('streaming a question turn', () => {
  it('streams start → content → done and persists the turn', async () => {
    const res = await POST(req({ message: 'I do marketing' }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await drainSse(res);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');

    // The selected question's prompt was streamed as content.
    const text = events
      .filter((e) => e.event === 'content')
      .map((e) => (e.data as { delta: string }).delta)
      .join('');
    expect(text).toBe('What is your role?');

    // The turn was persisted with the targeted question id.
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
    expect(runMock.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        targetedQuestionId: 'q1',
        userMessage: 'I do marketing',
      })
    );
  });
});

describe('streaming an offer turn', () => {
  it('delegates to the offer stream and persists the streamed message with no target', async () => {
    // The only question is already answered → assessment offers → the route streams the offer.
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...loadedContext().base,
          answered: [{ questionId: 'q1', confidence: null }],
        },
      })
    );

    const res = await POST(req({ message: 'I think that is everything' }), ctx);
    const events = await drainSse(res);

    expect(offerMock.streamOfferMessage).toHaveBeenCalledTimes(1);
    const text = events
      .filter((e) => e.event === 'content')
      .map((e) => (e.data as { delta: string }).delta)
      .join('');
    expect(text).toBe('Ready to submit?');
    // Offer turns target no question; the streamed message is persisted as the reply.
    expect(runMock.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({ targetedQuestionId: null, agentResponse: 'Ready to submit?' })
    );
  });
});
