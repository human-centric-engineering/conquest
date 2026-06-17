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
  abortSession: vi.fn(() => Promise.resolve('aborted')),
  persistAbuseStrikes: vi.fn(() => Promise.resolve()),
  persistSensitivity: vi.fn(() => Promise.resolve()),
  recordSensitivityFlagged: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => sessionsMock);

// The real resolveTurnAccess runs; stub only the token verify so the anonymous-path test
// isn't coupled to the HMAC crypto (which session-access-token.test.ts covers directly).
const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

// Reasoning trace builder — mocked so tests can control whether a non-empty trace is built
// without running the real pure builder (which inspects TurnResult internals).
const reasoningMock = vi.hoisted(() => ({ buildReasoningTrace: vi.fn() }));
vi.mock('@/lib/app/questionnaire/reasoning', () => ({
  buildReasoningTrace: reasoningMock.buildReasoningTrace,
}));

// Embedding lazy-ensure seams — mocked so the route never touches pgvector / the embedder here.
const slotEmbedMock = vi.hoisted(() => ({
  ensureVersionSlotsEmbedded: vi.fn(() => Promise.resolve({ embedded: 0, skipped: 0, total: 0 })),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => slotEmbedMock);
const dataSlotEmbedMock = vi.hoisted(() => ({
  ensureVersionDataSlotsEmbedded: vi.fn(() =>
    Promise.resolve({ embedded: 0, skipped: 0, total: 0 })
  ),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => dataSlotEmbedMock);

// Extraction pre-filter — mocked so the wiring (which lists the extractor sees) is asserted without
// running the real ranker. Default: a full-set passthrough (`applied:false`), so the flag being on
// changes nothing unless a test overrides it.
const prefilterMock = vi.hoisted(() => ({
  narrowExtractionCandidates: vi.fn(() =>
    Promise.resolve({
      questionSlots: [] as Array<{ key: string }>,
      dataSlots: [] as Array<{ key: string }>,
      applied: false,
      reason: 'below_threshold',
      questionsIn: 0,
      questionsOut: 0,
      dataSlotsIn: 0,
      dataSlotsOut: 0,
    })
  ),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/extraction-candidates', () => prefilterMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/messages/route';
import {
  ABUSE_ABANDON_REASON,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_TONE_SETTINGS,
} from '@/lib/app/questionnaire/types';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_COST_CAP_FLAG,
  APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
  APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG,
  APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
  APP_QUESTIONNAIRES_REASONING_STREAM_FLAG,
  APP_QUESTIONNAIRES_TONE_FLAG,
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
      // Spread all defaults so new config fields are automatically covered.
      // abuseThreshold is explicitly 0 (overriding DEFAULT's 4) so the seriousness
      // gate stays OFF for standard-turn tests that don't stub assessSeriousness.
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        abuseThreshold: 0,
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
      abuseStrikes: 0,
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
    // Present for CapabilityInvokers interface completeness; the seriousness gate is off
    // in default-context tests (abuseThreshold: 0) so this stub is not called.
    assessSeriousness: vi.fn(async () => ({ verdict: { serious: true, reason: '' }, costUsd: 0 })),
    // Dedicated sensitivity detector — runs every turn when the feature is on; defaults to
    // "nothing detected" so default-context tests are unaffected.
    detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
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
  // Pre-filter defaults: lazy-ensure no-ops; narrowing is a full-set passthrough (off-effect) unless
  // a test overrides it.
  slotEmbedMock.ensureVersionSlotsEmbedded.mockResolvedValue({ embedded: 0, skipped: 0, total: 0 });
  dataSlotEmbedMock.ensureVersionDataSlotsEmbedded.mockResolvedValue({
    embedded: 0,
    skipped: 0,
    total: 0,
  });
  prefilterMock.narrowExtractionCandidates.mockResolvedValue({
    questionSlots: [],
    dataSlots: [],
    applied: false,
    reason: 'below_threshold',
    questionsIn: 0,
    questionsOut: 0,
    dataSlotsIn: 0,
    dataSlotsOut: 0,
  });
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
  // Reasoning trace: default to empty so the standard turn tests are unaffected.
  reasoningMock.buildReasoningTrace.mockReturnValue([]);
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

  it('does not forward tone to the phraser when every dimension is off (the default)', async () => {
    // The default fixture config has tone all-off → the route omits `tone` from the phraser input
    // so the interviewer keeps its default voice.
    await drainSse(await POST(req({ message: 'I do marketing' }), ctx));

    const arg = questionMock.streamQuestionMessage.mock.calls[0][0] as {
      input: { tone?: unknown };
    };
    expect(arg.input.tone).toBeUndefined();
  });

  it('forwards the tone block to the phraser when the flag is on and a dimension is enabled', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...loadedContext().base,
          config: {
            ...DEFAULT_QUESTIONNAIRE_CONFIG,
            tone: { ...DEFAULT_TONE_SETTINGS, empathy: { enabled: true, level: 5 } },
          },
        },
      })
    );

    await drainSse(await POST(req({ message: 'I do marketing' }), ctx));

    const arg = questionMock.streamQuestionMessage.mock.calls[0][0] as {
      input: { tone?: { empathy: { enabled: boolean; level: number } } };
    };
    expect(arg.input.tone?.empathy).toEqual({ enabled: true, level: 5 });
  });

  it('does not forward tone when a dimension is enabled but the platform tone flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name !== APP_QUESTIONNAIRES_TONE_FLAG)
    );
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...loadedContext().base,
          config: {
            ...DEFAULT_QUESTIONNAIRE_CONFIG,
            tone: { ...DEFAULT_TONE_SETTINGS, empathy: { enabled: true, level: 5 } },
          },
        },
      })
    );

    await drainSse(await POST(req({ message: 'I do marketing' }), ctx));

    const arg = questionMock.streamQuestionMessage.mock.calls[0][0] as {
      input: { tone?: unknown };
    };
    expect(arg.input.tone).toBeUndefined();
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

describe('data-slot mode', () => {
  /** A context with a single data slot so the route enters data-slot mode. */
  function dataSlotContext() {
    const base = loadedContext();
    return loadedContext({
      base: {
        ...base.base,
        dataSlots: [
          {
            id: 'ds-1',
            key: 'department',
            name: 'Department',
            description: 'Which department do you work in?',
            theme: 'role',
            ordinal: 0,
            weight: 1,
          },
        ],
        dataSlotAnswered: [],
        dataSlotAttempts: {},
      },
    });
  }

  it('calls runDataSlotTurn (not runTurn) and passes dataSlotFills to persistTurn', async () => {
    // Arrange: data-slots flag is already on globally (isFeatureEnabled → true).
    // Stub isFeatureEnabled so data-slots is explicitly confirmed on.
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_DATA_SLOTS_FLAG || true)
    );
    ctxMock.buildTurnContext.mockResolvedValue(dataSlotContext());

    // The question-message phraser is called from the data_slot response branch.
    // Override it to echo the data-slot's name so we can assert the stream path.
    questionMock.streamQuestionMessage.mockImplementation(async function* (opts: {
      input: { prompt: string };
    }) {
      yield { type: 'content', delta: opts.input.prompt };
      return { message: opts.input.prompt, costUsd: 0 };
    });

    // Act
    const res = await POST(req({ message: 'I work in marketing' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);

    // Assert: the stream completes with a done frame (route wired to data-slot orchestrator).
    const eventNames = frames.map((f) => f.event);
    expect(eventNames[0]).toBe('start');
    expect(eventNames[eventNames.length - 1]).toBe('done');
    expect(eventNames).toContain('content');

    // The route should persist with a dataSlotFills array (data-slot mode wiring).
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
    expect(runMock.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({ dataSlotFills: expect.any(Array) })
    );
  });

  it('builds the dataSlotFillByDataSlotId map from pre-existing fills (passes current to extractor)', async () => {
    // Arrange: a context with a data slot that already has a prior fill — exercises the
    // `(loaded.base.dataSlotAnswered ?? []).map(...)` path and the `current` field in
    // the invoker's candidate build.
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_DATA_SLOTS_FLAG || true)
    );
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...baseCtx.base,
          dataSlots: [
            {
              id: 'ds-1',
              key: 'department',
              name: 'Department',
              description: 'Which department?',
              theme: 'role',
              ordinal: 0,
              weight: 1,
            },
          ],
          // A prior fill for ds-1 — exercises the map() body (line 257) and the `current` spread.
          dataSlotAnswered: [
            {
              dataSlotId: 'ds-1',
              value: 'Engineering',
              paraphrase: 'Works in Engineering',
              confidence: 0.85,
            },
          ],
          dataSlotAttempts: { 'ds-1': 1 },
        },
      })
    );
    questionMock.streamQuestionMessage.mockImplementation(async function* (opts: {
      input: { prompt: string };
    }) {
      yield { type: 'content', delta: opts.input.prompt };
      return { message: opts.input.prompt, costUsd: 0 };
    });

    const res = await POST(req({ message: 'I am in Engineering' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    expect(frames.map((f) => f.event)).toContain('done');

    // The extractor candidate should carry the prior fill as 'current' — the route must
    // pass `dataSlotCandidates` with the fill data to buildTurnInvokers so the extractor
    // can update/correct it across turns rather than re-deriving from scratch.
    const invokerArgs = invokersMock.buildTurnInvokers.mock.calls[0][0] as {
      dataSlotCandidates: Array<{ key: string; current?: { value: unknown } }>;
    };
    const candidate = invokerArgs.dataSlotCandidates?.find((c) => c.key === 'department');
    expect(candidate?.current?.value).toBe('Engineering');
  });
});

describe('extraction pre-filter', () => {
  /** A context with two question slots + two data slots — enough to assert narrowing. */
  function multiSlotContext() {
    const base = loadedContext();
    return loadedContext({
      slots: [
        {
          id: 'q1',
          key: 'q1',
          sectionId: 's1',
          prompt: 'Role?',
          type: 'free_text',
          required: false,
        },
        {
          id: 'q2',
          key: 'q2',
          sectionId: 's1',
          prompt: 'Tenure?',
          type: 'free_text',
          required: false,
        },
      ],
      base: {
        ...base.base,
        recentMessages: ['I just joined the marketing team'],
        dataSlots: [
          {
            id: 'ds-1',
            key: 'department',
            name: 'Department',
            description: 'Which dept?',
            theme: 'role',
            ordinal: 0,
            weight: 1,
          },
          {
            id: 'ds-2',
            key: 'tenure',
            name: 'Tenure',
            description: 'How long?',
            theme: 'role',
            ordinal: 1,
            weight: 1,
          },
        ],
        dataSlotAnswered: [],
        dataSlotAttempts: {},
      },
    });
  }

  /** The args the route passed to the (mocked) invoker builder. */
  function invokerArgs() {
    return invokersMock.buildTurnInvokers.mock.calls[0][0] as {
      slots: Array<{ key: string }>;
      extractionCandidateSlots?: Array<{ key: string }>;
      dataSlotCandidates?: Array<{ key: string }>;
    };
  }

  it('narrows the extractor candidates when applied, while detector/refiner keep the full slots', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(multiSlotContext());
    prefilterMock.narrowExtractionCandidates.mockResolvedValue({
      questionSlots: [{ key: 'q1' }], // keep q1, drop q2
      dataSlots: [{ key: 'department' }], // keep ds-1, drop ds-2
      applied: true,
      reason: 'narrowed',
      questionsIn: 2,
      questionsOut: 1,
      dataSlotsIn: 2,
      dataSlotsOut: 1,
    });

    const res = await POST(req({ message: 'I just joined the marketing team' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);

    const args = invokerArgs();
    // Full slots still flow to the detector/refiner (their coverage is unchanged).
    expect(args.slots.map((s) => s.key).sort()).toEqual(['q1', 'q2']);
    // The extractor sees ONLY the narrowed question slots + data-slot candidates.
    expect(args.extractionCandidateSlots?.map((s) => s.key)).toEqual(['q1']);
    expect(args.dataSlotCandidates?.map((s) => s.key)).toEqual(['department']);
  });

  it('sends the full candidate set when the flag is off (no extractionCandidateSlots; narrow not called)', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name !== APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG)
    );
    ctxMock.buildTurnContext.mockResolvedValue(multiSlotContext());

    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);

    expect(prefilterMock.narrowExtractionCandidates).not.toHaveBeenCalled();
    const args = invokerArgs();
    expect(args.extractionCandidateSlots).toBeUndefined();
    expect(args.dataSlotCandidates?.map((s) => s.key).sort()).toEqual(['department', 'tenure']);
  });

  it('keeps the full set on a passthrough result (no-op / below threshold)', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(multiSlotContext());
    // default mock → applied:false passthrough
    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);

    const args = invokerArgs();
    expect(args.extractionCandidateSlots?.map((s) => s.key).sort()).toEqual(['q1', 'q2']);
    expect(args.dataSlotCandidates?.map((s) => s.key).sort()).toEqual(['department', 'tenure']);
  });

  it('completes the turn fail-soft when the lazy embed throws', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(multiSlotContext());
    slotEmbedMock.ensureVersionSlotsEmbedded.mockRejectedValue(new Error('embedder down'));
    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);
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

describe('POST /messages — seriousness / abuse gate', () => {
  /** Invokers where the extractor flags suspicion and the judge rules the answer non-serious. */
  function abusiveInvokers() {
    return {
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: '543 years',
            confidence: 0.9,
            provenance: 'direct',
            rationale: 'stated',
            isActiveQuestion: true,
          },
        ],
        suspectedNonGenuine: true,
        costUsd: 0,
      })),
      detectContradictions: vi.fn(async () => ({ findings: [], costUsd: 0 })),
      refineAnswer: vi.fn(async () => ({ decisions: [], costUsd: 0 })),
      selectNext: vi.fn(async () => ({
        decision: { kind: 'ask', questionId: 'q1', rationale: 'x', costUsd: 0 },
      })),
      assessSeriousness: vi.fn(async () => ({
        verdict: { serious: false, reason: 'That tenure is not possible.' },
        costUsd: 0,
      })),
      detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
    };
  }

  function gateContext(abuseStrikes: number) {
    const ctx = loadedContext();
    return loadedContext({
      activeQuestionKey: 'q1',
      base: { ...ctx.base, abuseStrikes, config: { ...ctx.base.config, abuseThreshold: 4 } },
    });
  }

  it('disregards a non-serious answer and persists the strike (below threshold)', async () => {
    invokersMock.buildTurnInvokers.mockResolvedValue(abusiveInvokers());
    ctxMock.buildTurnContext.mockResolvedValue(gateContext(0));

    await drainSse(await POST(req({ message: '543 years' }), ctx));

    expect(sessionsMock.persistAbuseStrikes).toHaveBeenCalledWith('sess-1', 1);
    expect(sessionsMock.abortSession).not.toHaveBeenCalled();
    // The disregarded answer is never handed to persistence as an upsert.
    expect(runMock.persistTurn).toHaveBeenCalledWith(expect.objectContaining({ upserts: [] }));
  });

  it('aborts the session on the threshold strike, recording the analytics reason', async () => {
    invokersMock.buildTurnInvokers.mockResolvedValue(abusiveInvokers());
    ctxMock.buildTurnContext.mockResolvedValue(gateContext(3)); // next strike is the 4th

    await drainSse(await POST(req({ message: 'garbage' }), ctx));

    expect(sessionsMock.persistAbuseStrikes).toHaveBeenCalledWith('sess-1', 4);
    expect(sessionsMock.abortSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ reason: ABUSE_ABANDON_REASON })
    );
  });
});

describe('sensitivity awareness / safeguarding', () => {
  const SUMMARY = 'Reports mistreatment by a senior colleague.';

  /** A context with sensitivity awareness on + a support message configured. */
  function sensitiveContext() {
    const base = loadedContext();
    return loadedContext({
      activeQuestionKey: 'q1',
      base: {
        ...base.base,
        config: {
          ...base.base.config,
          sensitivityAwareness: true,
          supportMessage: 'Support is available.',
          supportResourceUrl: 'https://help.example',
        },
      },
    });
  }

  /** Invokers whose extractor flags a high-severity disclosure; selection still asks q1. */
  function disclosingInvokers() {
    const inv = stubInvokers();
    inv.extractAnswers = vi.fn(async () => ({
      intents: [],
      costUsd: 0,
      sensitivity: { detected: true, severity: 'high', category: 'harassment', summary: SUMMARY },
    }));
    return inv;
  }

  beforeEach(() => {
    ctxMock.buildTurnContext.mockResolvedValue(sensitiveContext());
    invokersMock.buildTurnInvokers.mockResolvedValue(disclosingInvokers());
  });

  it('persists the disclosure (level + note) and writes a flagged event without the summary', async () => {
    await drainSse(await POST(req({ message: 'I was abused by the CEO' }), ctx));

    expect(sessionsMock.persistSensitivity).toHaveBeenCalledWith(
      'sess-1',
      'high',
      expect.objectContaining({ severity: 'high', category: 'harassment', summary: SUMMARY })
    );
    // The event carries severity + category ONLY — never the summary (PII).
    expect(sessionsMock.recordSensitivityFlagged).toHaveBeenCalledWith('sess-1', {
      severity: 'high',
      category: 'harassment',
    });
    const eventArg = (sessionsMock.recordSensitivityFlagged as Mock).mock.calls[0]?.[1];
    expect(JSON.stringify(eventArg)).not.toContain('colleague');
  });

  it('streams a support signpost frame with the configured copy + URL', async () => {
    const frames = await drainSse(await POST(req({ message: 'I was abused by the CEO' }), ctx));
    // Assert the frame's structured shape — not just that some string contains the copy.
    // The support signpost is a 'warning' event with code 'support' emitted by the orchestrator.
    const support = frames.find(
      (f) => f.event === 'warning' && (f.data as { code?: string }).code === 'support'
    );
    expect(support).toBeDefined();
    expect((support!.data as { code: string; message: string }).code).toBe('support');
    expect((support!.data as { code: string; message: string }).message).toContain(
      'Support is available.'
    );
    expect((support!.data as { code: string; message: string }).message).toContain(
      'https://help.example'
    );
  });

  it('threads the just-detected disclosure into the question phraser (gentle tone this turn)', async () => {
    await drainSse(await POST(req({ message: 'I was abused by the CEO' }), ctx));
    const input = (questionMock.streamQuestionMessage as Mock).mock.calls[0]?.[0]?.input;
    expect(input.sensitivityLevel).toBe('high');
    expect(input.sensitivityNotes).toContain(SUMMARY);
  });

  it('still emits a done frame when persistSensitivity rejects (fail-soft: already streamed)', async () => {
    // Arrange: sensitivity persistence fails after the reply has already been streamed.
    sessionsMock.persistSensitivity.mockRejectedValue(new Error('db write failed'));

    // Act
    const res = await POST(req({ message: 'I was abused by the CEO' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);

    // Assert: the stream completes normally — the bookkeeping failure is swallowed.
    const events = frames.map((f) => f.event);
    expect(events).toContain('content');
    expect(events[events.length - 1]).toBe('done');
  });

  it('does nothing when the per-questionnaire toggle is off', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ activeQuestionKey: 'q1' }));
    await drainSse(await POST(req({ message: 'I was abused by the CEO' }), ctx));
    expect(sessionsMock.persistSensitivity).not.toHaveBeenCalled();
    expect(sessionsMock.recordSensitivityFlagged).not.toHaveBeenCalled();
  });
});

describe('reasoning stream (F9.9)', () => {
  /** A context with reasoning stream on (both platform flag and per-version toggle). */
  function reasoningContext(persist = false) {
    const base = loadedContext();
    return loadedContext({
      base: {
        ...base.base,
        config: {
          ...base.base.config,
          reasoningStreamEnabled: true,
          reasoningStreamPersist: persist,
        },
      },
    });
  }

  it('emits a reasoning frame before the content when the trace is non-empty', async () => {
    // Arrange: platform flag on AND per-version toggle on.
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_REASONING_STREAM_FLAG || true)
    );
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext());
    // The builder returns a non-empty trace so the route emits the reasoning frame.
    const steps = [{ kind: 'answer_captured', label: 'Captured your answer', tone: 'positive' }];
    reasoningMock.buildReasoningTrace.mockReturnValue(steps);

    const frames = await drainSse(await POST(req({ message: 'I do sales' }), ctx));

    // A 'reasoning' frame should appear between 'start' and 'content'.
    const eventNames = frames.map((f) => f.event);
    expect(eventNames).toContain('reasoning');
    const reasoningFrame = frames.find((f) => f.event === 'reasoning');
    expect((reasoningFrame!.data as { steps: unknown[] }).steps).toHaveLength(1);

    // The reasoning frame must precede any content frame (emitted before the reply).
    const reasoningIdx = eventNames.indexOf('reasoning');
    const firstContentIdx = eventNames.indexOf('content');
    expect(reasoningIdx).toBeLessThan(firstContentIdx);
  });

  it('does not emit a reasoning frame when the trace is empty', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_REASONING_STREAM_FLAG || true)
    );
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext());
    // Builder returns empty → no frame emitted.
    reasoningMock.buildReasoningTrace.mockReturnValue([]);

    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));
    expect(frames.map((f) => f.event)).not.toContain('reasoning');
  });

  it('persists the trace when the version opts into persistence', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_REASONING_STREAM_FLAG || true)
    );
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext(true)); // persist = true
    const steps = [
      { kind: 'next_question', label: 'Moving to the next question', tone: 'neutral' },
    ];
    reasoningMock.buildReasoningTrace.mockReturnValue(steps);

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // When persist is true, the reasoning trace is passed to persistTurn.
    expect(runMock.persistTurn).toHaveBeenCalledWith(expect.objectContaining({ reasoning: steps }));
  });

  it('does not persist the trace when the version does not opt into persistence', async () => {
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name === APP_QUESTIONNAIRES_REASONING_STREAM_FLAG || true)
    );
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext(false)); // persist = false
    const steps = [{ kind: 'answer_captured', label: 'Got it', tone: 'positive' }];
    reasoningMock.buildReasoningTrace.mockReturnValue(steps);

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // The frame streamed but the trace must NOT be saved (live-only when persist is off).
    const persistArg = runMock.persistTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persistArg.reasoning).toBeUndefined();
  });

  it('does not emit a reasoning frame when the platform flag is off', async () => {
    // The platform flag overrides the per-version toggle — when off, nothing streams.
    vi.mocked(isFeatureEnabled).mockImplementation((name: string) =>
      Promise.resolve(name !== APP_QUESTIONNAIRES_REASONING_STREAM_FLAG)
    );
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext());
    reasoningMock.buildReasoningTrace.mockReturnValue([
      { kind: 'answer_captured', label: 'Got it', tone: 'positive' },
    ]);

    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));
    expect(frames.map((f) => f.event)).not.toContain('reasoning');
    // The builder is never called when the flag is off.
    expect(reasoningMock.buildReasoningTrace).not.toHaveBeenCalled();
  });
});

describe('contradiction detail enrichment', () => {
  /**
   * Invokers that trigger a contradiction warning with both a suggestedProbe (the public
   * message) and a separate explanation. The route must enrich the warning frame with the
   * explanation as `detail` when it differs from the message.
   */
  function contradictionInvokers() {
    return {
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: 'senior manager',
            confidence: 0.9,
            provenance: 'direct',
            rationale: 'stated',
            isActiveQuestion: true,
          },
        ],
        costUsd: 0,
      })),
      detectContradictions: vi.fn(async () => ({
        findings: [
          {
            slotKeys: ['q1'],
            explanation: 'Earlier said junior; now says senior',
            severity: 'medium' as const,
            confidence: 0.8,
            // suggestedProbe is different from explanation — the route shows suggestedProbe
            // as the message but attaches explanation as a detail for "Why?" disclosure.
            suggestedProbe: 'Can you clarify your seniority level?',
          },
        ],
        costUsd: 0,
      })),
      refineAnswer: vi.fn(async () => ({ decisions: [], costUsd: 0 })),
      selectNext: vi.fn(async () => ({
        decision: { kind: 'ask', questionId: 'q1', rationale: 'first', costUsd: 0 },
      })),
      assessSeriousness: vi.fn(async () => ({
        verdict: { serious: true, reason: '' },
        costUsd: 0,
      })),
    };
  }

  it('enriches a contradiction warning frame with the explanation as detail when suggestedProbe differs', async () => {
    // Need ≥ MIN_CONTRADICTION_ANSWERS (2) existing answers and contradictionMode ≠ 'off'.
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        activeQuestionKey: 'q1',
        base: {
          ...baseCtx.base,
          // Two distinct slot answers so the orchestrator's MIN_CONTRADICTION_ANSWERS gate passes.
          existingAnswers: [
            { slotKey: 'q1', value: 'junior', provenance: 'direct' as const, confidence: 0.7 },
            { slotKey: 'role', value: 'engineer', provenance: 'direct' as const, confidence: 0.8 },
          ],
          config: {
            ...baseCtx.base.config,
            // contradictionMode must be non-'off' for detection to run.
            contradictionMode: 'flag',
            contradictionEveryNTurns: 1,
          },
        },
      })
    );
    invokersMock.buildTurnInvokers.mockResolvedValue(contradictionInvokers());

    const frames = await drainSse(await POST(req({ message: 'senior manager' }), ctx));

    // The contradiction warning frame must carry the explanation as 'detail'.
    const contradictionFrame = frames.find(
      (f) => f.event === 'warning' && (f.data as { code?: string }).code === 'contradiction'
    );
    expect(contradictionFrame).toBeDefined();
    const data = contradictionFrame!.data as { code: string; message: string; detail?: string };
    expect(data.message).toBe('Can you clarify your seniority level?');
    expect(data.detail).toBe('Earlier said junior; now says senior');
  });
});

describe('abuse gate write failure (fail-soft)', () => {
  function abusiveInvokers() {
    return {
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: '543 years',
            confidence: 0.9,
            provenance: 'direct',
            rationale: 'stated',
            isActiveQuestion: true,
          },
        ],
        suspectedNonGenuine: true,
        costUsd: 0,
      })),
      detectContradictions: vi.fn(async () => ({ findings: [], costUsd: 0 })),
      refineAnswer: vi.fn(async () => ({ decisions: [], costUsd: 0 })),
      selectNext: vi.fn(async () => ({
        decision: { kind: 'ask', questionId: 'q1', rationale: 'x', costUsd: 0 },
      })),
      assessSeriousness: vi.fn(async () => ({
        verdict: { serious: false, reason: 'Impossible tenure.' },
        costUsd: 0,
      })),
    };
  }

  function gateContext(abuseStrikes: number) {
    const base = loadedContext();
    return loadedContext({
      activeQuestionKey: 'q1',
      base: { ...base.base, abuseStrikes, config: { ...base.base.config, abuseThreshold: 4 } },
    });
  }

  it('still emits done when persistAbuseStrikes rejects (reply already streamed — fail-soft)', async () => {
    // Arrange: the abuse gate fires (strike below threshold) but the DB write fails.
    invokersMock.buildTurnInvokers.mockResolvedValue(abusiveInvokers());
    ctxMock.buildTurnContext.mockResolvedValue(gateContext(0));
    sessionsMock.persistAbuseStrikes.mockRejectedValue(new Error('strike write boom'));

    // Act
    const res = await POST(req({ message: 'garbage' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);

    // Assert: the bookkeeping failure is swallowed — done is still emitted.
    const eventNames = frames.map((f) => f.event);
    expect(eventNames).toContain('content');
    expect(eventNames[eventNames.length - 1]).toBe('done');
  });
});
