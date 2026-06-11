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

const questionMock = vi.hoisted(() => ({ streamQuestionMessage: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/question-stream', () => questionMock);

// Cost-cap seams (F6.3): the route sums prior spend + writes events / pauses on a breach.
const turnsMock = vi.hoisted(() => ({ sumSessionTurnCost: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turns', () => turnsMock);

const sessionsMock = vi.hoisted(() => ({
  recordCostCapReached: vi.fn(() => Promise.resolve()),
  pauseSession: vi.fn(() => Promise.resolve('paused')),
  hasCostCapReachedEvent: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => sessionsMock);

// The real resolveTurnAccess runs; stub only the token verify so the anonymous-path test
// isn't coupled to the HMAC crypto (which session-access-token.test.ts covers directly).
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/messages/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
} from '@/lib/app/questionnaire/constants';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/messages';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    url: URL,
    headers: new Headers(headers),
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
    meta: {},
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
  // Phrasing on by default in these tests (all sub-flags true): echo the verbatim prompt so
  // existing content assertions hold; the real fail-soft/streaming is covered in question-stream.test.ts.
  questionMock.streamQuestionMessage.mockImplementation(async function* (opts: {
    input: { prompt: string };
  }) {
    yield { type: 'content', delta: opts.input.prompt };
    return { message: opts.input.prompt, costUsd: 0 };
  });
  turnsMock.sumSessionTurnCost.mockResolvedValue(0);
  sessionsMock.recordCostCapReached.mockResolvedValue(undefined);
  sessionsMock.pauseSession.mockResolvedValue('paused');
  sessionsMock.hasCostCapReachedEvent.mockResolvedValue(false);
});

/** A loaded context carrying a USD budget; `answered` optionally pre-answers the only question. */
function cappedContext(capUsd: number, answered: Array<{ questionId: string }> = []) {
  const baseCtx = loadedContext();
  return loadedContext({
    base: {
      ...baseCtx.base,
      config: { ...baseCtx.base.config, costBudgetUsd: capUsd },
      answered: answered.map((a) => ({ questionId: a.questionId, confidence: null })),
    },
  });
}

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

  it('accepts a kickoff turn with no message and streams the opening question', async () => {
    // The proactive opening: the surface fires `{ kickoff: true }` once on a fresh session.
    const res = await POST(req({ kickoff: true }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await drainSse(res);
    expect(events.map((e) => e.event)).toContain('content');

    // The opening question is phrased with an EMPTY last-user-message (no answer to acknowledge)
    // and persisted with an empty `userMessage` — which `recentMessages` then skips next turn.
    const arg = questionMock.streamQuestionMessage.mock.calls[0][0] as {
      input: { lastUserMessage: string; isOpening: boolean };
    };
    expect(arg.input.lastUserMessage).toBe('');
    expect(arg.input.isOpening).toBe(true);
    expect(runMock.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', userMessage: '' })
    );
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

  it('runs the conversational phraser (with the verbatim prompt + last message) when phrasing is on', async () => {
    await drainSse(await POST(req({ message: 'I do marketing' }), ctx));

    expect(questionMock.streamQuestionMessage).toHaveBeenCalledTimes(1);
    const arg = questionMock.streamQuestionMessage.mock.calls[0][0] as {
      input: { prompt: string; lastUserMessage: string; isOpening: boolean };
    };
    expect(arg.input.prompt).toBe('What is your role?');
    expect(arg.input.lastUserMessage).toBe('I do marketing');
    // No prior turns in the fixture (selectionRound 0) → this is the opening question.
    expect(arg.input.isOpening).toBe(true);
  });

  it('falls back to the verbatim prompt (no phraser) when question phrasing is disabled', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name !== APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG)
    );

    const events = await drainSse(await POST(req({ message: 'I do marketing' }), ctx));

    expect(questionMock.streamQuestionMessage).not.toHaveBeenCalled();
    const text = events
      .filter((e) => e.event === 'content')
      .map((e) => (e.data as { delta: string }).delta)
      .join('');
    expect(text).toBe('What is your role?');
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
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
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

describe('anonymous (no-login) access', () => {
  it('grants a session-token-bearing anonymous caller and streams the turn', async () => {
    setAuth(null); // no cookie session
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: { id: 'sess-1', status: 'active', versionId: 'v1', respondentUserId: null },
      })
    );

    const res = await POST(req({ message: 'hello' }, { 'x-session-token': 'tok.sig' }), ctx);
    expect(res.status).toBe(200);
    const types = (await drainSse(res)).map((e) => e.event);
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('done');
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
  });

  it('401s an anonymous session with no/invalid token (no turn run)', async () => {
    setAuth(null);
    tokenMock.verifySessionToken.mockReturnValue({ ok: false, reason: 'bad_signature' });
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: { id: 'sess-1', status: 'active', versionId: 'v1', respondentUserId: null },
      })
    );
    const res = await POST(req({ message: 'hello' }, { 'x-session-token': 'bad' }), ctx);
    expect(res.status).toBe(401);
    expect(runMock.persistTurn).not.toHaveBeenCalled();
  });
});

describe('fail-soft persistence', () => {
  it('still completes the stream with `done` when persistTurn rejects (logged, not 5xx)', async () => {
    runMock.persistTurn.mockRejectedValue(new Error('db boom'));
    const res = await POST(req({ message: 'I do marketing' }), ctx);
    expect(res.status).toBe(200);
    const types = (await drainSse(res)).map((e) => e.event);
    // The reply already streamed; the persistence failure is swallowed and `done` still lands.
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');
  });
});

describe('cost cap (F6.3)', () => {
  it('does not sum spend or write events when no budget is configured (cap null)', async () => {
    const res = await POST(req({ message: 'hi' }), ctx); // default context: costBudgetUsd null
    expect(res.status).toBe(200);
    expect(turnsMock.sumSessionTurnCost).not.toHaveBeenCalled();
    expect(sessionsMock.recordCostCapReached).not.toHaveBeenCalled();
  });

  it('runs the turn normally when spend is below the soft threshold', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0));
    turnsMock.sumSessionTurnCost.mockResolvedValue(0.5); // 50%
    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res); // persistTurn runs inside the streamed generator
    expect(sessionsMock.recordCostCapReached).not.toHaveBeenCalled();
    expect(sessionsMock.pauseSession).not.toHaveBeenCalled();
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
  });

  it('refuses the turn with 402, auto-pauses, and writes a hard event when at/over the cap', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0));
    turnsMock.sumSessionTurnCost.mockResolvedValue(1.2); // 120%
    const res = await POST(req({ message: 'hi' }), ctx);

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; details: { spentUsd: number; capUsd: number } };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('COST_CAP_REACHED');
    // The spend context is surfaced to the client.
    expect(body.error.details).toEqual({ spentUsd: 1.2, capUsd: 1.0 });
    expect(sessionsMock.recordCostCapReached).toHaveBeenCalledWith('sess-1', {
      spentUsd: 1.2,
      capUsd: 1.0,
      tier: 'hard',
    });
    expect(sessionsMock.pauseSession).toHaveBeenCalledWith('sess-1', { reason: 'cost_cap' });
    // Pause FIRST, then record — enforcement is durable even if the audit write fails.
    expect(sessionsMock.pauseSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsMock.recordCostCapReached.mock.invocationCallOrder[0]
    );
    // The turn never ran — no invokers, no persistence.
    expect(invokersMock.buildTurnInvokers).not.toHaveBeenCalled();
    expect(runMock.persistTurn).not.toHaveBeenCalled();
  });

  it('soft cap: runs the turn, writes a soft event once, and biases the offer with a wrap-up', async () => {
    // Pre-answer the only question so the assessment offers; soft pressure threads costWrapUp.
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0, [{ questionId: 'q1' }]));
    turnsMock.sumSessionTurnCost.mockResolvedValue(0.95); // 95%

    const res = await POST(req({ message: 'I think that is everything' }), ctx);
    expect(res.status).toBe(200);
    const types = (await drainSse(res)).map((e) => e.event);
    expect(types[types.length - 1]).toBe('done');

    expect(sessionsMock.recordCostCapReached).toHaveBeenCalledWith('sess-1', {
      spentUsd: 0.95,
      capUsd: 1.0,
      tier: 'soft',
    });
    // The offer composer was handed the wrap-up flag.
    expect(offerMock.streamOfferMessage).toHaveBeenCalledTimes(1);
    const offerArgs = offerMock.streamOfferMessage.mock.calls[0][0] as {
      input: { costWrapUp?: boolean };
    };
    expect(offerArgs.input.costWrapUp).toBe(true);
  });

  it('hard cap: pauses and still returns 402 even if the audit-event write fails', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0));
    turnsMock.sumSessionTurnCost.mockResolvedValue(1.2);
    sessionsMock.recordCostCapReached.mockRejectedValue(new Error('event write boom'));

    const res = await POST(req({ message: 'hi' }), ctx);
    // Enforcement (pause) is durable and the 402 contract holds even when the marker write fails.
    expect(res.status).toBe(402);
    expect(sessionsMock.pauseSession).toHaveBeenCalledWith('sess-1', { reason: 'cost_cap' });
    expect(invokersMock.buildTurnInvokers).not.toHaveBeenCalled();
  });

  it('soft cap: a failed audit-event write does not fail the (advisory) turn', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0, [{ questionId: 'q1' }]));
    turnsMock.sumSessionTurnCost.mockResolvedValue(0.95);
    sessionsMock.recordCostCapReached.mockRejectedValue(new Error('event write boom'));

    const res = await POST(req({ message: 'more' }), ctx);
    expect(res.status).toBe(200);
    const types = (await drainSse(res)).map((e) => e.event);
    // The soft cap is a nudge — a bookkeeping failure must not 500 a turn that should run.
    expect(types[types.length - 1]).toBe('done');
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
  });

  it('soft cap: does not re-write the soft event when one already exists (dedupe)', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0, [{ questionId: 'q1' }]));
    turnsMock.sumSessionTurnCost.mockResolvedValue(0.95);
    sessionsMock.hasCostCapReachedEvent.mockResolvedValue(true); // already recorded earlier

    const res = await POST(req({ message: 'more' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);
    expect(sessionsMock.recordCostCapReached).not.toHaveBeenCalled();
  });

  it('does not enforce when the cost-cap sub-flag is off, even over the cap', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name !== APP_QUESTIONNAIRES_COST_CAP_FLAG)
    );
    ctxMock.buildTurnContext.mockResolvedValue(cappedContext(1.0));
    turnsMock.sumSessionTurnCost.mockResolvedValue(2.0); // would be hard if enforced

    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res); // persistTurn runs inside the streamed generator
    expect(turnsMock.sumSessionTurnCost).not.toHaveBeenCalled();
    expect(sessionsMock.recordCostCapReached).not.toHaveBeenCalled();
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
  });
});
