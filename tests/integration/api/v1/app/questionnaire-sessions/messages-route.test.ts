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

// Retry dedup (F7.x): the route looks up a persisted turn by the attempt's idempotency key and
// replays it instead of re-running. Mocked so a test can return a saved turn; defaults to null (no
// prior turn → fresh run), so the standard tests — which carry no key — are unaffected.
const transcriptMock = vi.hoisted(() => ({ findTurnByIdempotencyKey: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/transcript', () => transcriptMock);

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/messages/route';
import {
  ABUSE_ABANDON_REASON,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_TONE_SETTINGS,
} from '@/lib/app/questionnaire/types';
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
  // Restore a clean resolve each test: clearAllMocks() wipes call history but NOT a mockRejectedValue
  // implementation, so a per-test rejection (e.g. the abuse-gate write-failure block) would otherwise
  // bleed into later tests that call persistAbuseStrikes.
  sessionsMock.persistAbuseStrikes.mockResolvedValue(undefined);
  // Same clearAllMocks() gotcha for the sensitivity-persist path: a per-test rejection (the
  // sensitivity write-failure block) must not bleed into a later test that flags a disclosure.
  sessionsMock.persistSensitivity.mockResolvedValue(undefined);
  // Reasoning trace: default to empty so the standard turn tests are unaffected.
  reasoningMock.buildReasoningTrace.mockReturnValue([]);
  // Retry dedup: default to "no prior turn under this key" so a standard send runs fresh.
  transcriptMock.findTurnByIdempotencyKey.mockResolvedValue(null);
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

  it('410s (VERSION_ARCHIVED) when the running version has been archived mid-session', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: { id: 'sess-1', status: 'active', versionId: 'v1', respondentUserId: USER },
        versionArchivedAt: new Date(),
      })
    );
    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe('VERSION_ARCHIVED');
  });

  it('still serves a preview session on an archived version (admin rehearsal is exempt)', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        // Authenticated owner keeps turn-access simple; `isPreview` is the branch under test.
        session: {
          id: 'sess-1',
          status: 'active',
          versionId: 'v1',
          respondentUserId: USER,
          isPreview: true,
        },
        versionArchivedAt: new Date(),
      })
    );
    // Not the 410 gate — a preview turn proceeds (streamed SSE 200), proving the exemption.
    expect((await POST(req({ message: 'hi' }), ctx)).status).toBe(200);
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
        // The pre-filter is now a per-questionnaire Settings toggle (config), not a platform flag.
        config: { ...base.base.config, extractionPrefilter: true },
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

    const res = await POST(req({ message: 'actually our pipeline is very poor' }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);

    // The pre-filter must rank against the respondent's CURRENT answer — so the message they just
    // sent is appended as the last (query) entry, not the prior interviewer turn.
    const narrowCall = prefilterMock.narrowExtractionCandidates.mock.calls[0] as unknown[];
    const narrowArgs = narrowCall[0] as { recentMessages: string[] };
    expect(narrowArgs.recentMessages.at(-1)).toBe('actually our pipeline is very poor');

    const args = invokerArgs();
    // Full slots still flow to the detector/refiner (their coverage is unchanged).
    expect(args.slots.map((s) => s.key).sort()).toEqual(['q1', 'q2']);
    // The extractor sees ONLY the narrowed question slots + data-slot candidates.
    expect(args.extractionCandidateSlots?.map((s) => s.key)).toEqual(['q1']);
    expect(args.dataSlotCandidates?.map((s) => s.key)).toEqual(['department']);
  });

  it('sends the full candidate set when the Settings toggle is off (no extractionCandidateSlots; narrow not called)', async () => {
    const offContext = multiSlotContext();
    offContext.base.config.extractionPrefilter = false;
    ctxMock.buildTurnContext.mockResolvedValue(offContext);

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
    // Arrange: per-version toggle on.
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
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext());
    // Builder returns empty → no frame emitted.
    reasoningMock.buildReasoningTrace.mockReturnValue([]);

    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));
    expect(frames.map((f) => f.event)).not.toContain('reasoning');
  });

  it('persists the trace when the version opts into persistence', async () => {
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
    ctxMock.buildTurnContext.mockResolvedValue(reasoningContext(false)); // persist = false
    const steps = [{ kind: 'answer_captured', label: 'Got it', tone: 'positive' }];
    reasoningMock.buildReasoningTrace.mockReturnValue(steps);

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // The frame streamed but the trace must NOT be saved (live-only when persist is off).
    const persistArg = runMock.persistTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persistArg.reasoning).toBeUndefined();
  });
});

describe('contradiction notice — explanation is the message (flag mode)', () => {
  /**
   * Invokers that trigger a flag-mode contradiction warning. The finding carries BOTH an
   * `explanation` and a `suggestedProbe`. The contradiction phase always sets the notice
   * `message` to `finding.explanation` (in both flag and probe mode — the probe question is asked
   * as the interviewer turn, never as the notice), so the route surfaces the explanation as the
   * warning message and adds NO `detail` (the enrichment fires only when detail ≠ message).
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
            // A probe is present, but the blue notice is INFORMATIONAL — it shows the explanation,
            // never the question (under `probe` mode the question is asked as the interviewer turn).
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
      // Match the full CapabilityInvokers shape — a config change enabling sensitivity would
      // otherwise hit `invokers.detectSensitivity is not a function`.
      detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
    };
  }

  it('shows the explanation (not the probe) as the contradiction notice message under flag mode', async () => {
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

    // The contradiction notice is informational: its message IS the explanation (no separate
    // "Why?" detail, since the message already carries it). The probe question is never shown here.
    const contradictionFrame = frames.find(
      (f) => f.event === 'warning' && (f.data as { code?: string }).code === 'contradiction'
    );
    expect(contradictionFrame).toBeDefined();
    const data = contradictionFrame!.data as { code: string; message: string; detail?: string };
    expect(data.message).toBe('Earlier said junior; now says senior');
    expect(data.message).not.toBe('Can you clarify your seniority level?');
    expect(data.detail).toBeUndefined();

    // "Don't nag" ledger: a freshly-surfaced flag-mode conflict is recorded on the session so it is
    // never re-alerted on a later turn. The route threads the phase's updated ledger to persistTurn.
    expect(runMock.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        raisedContradictions: [
          expect.objectContaining({ key: 'q1', slotKeys: ['q1'], resolution: 'flagged' }),
        ],
      })
    );
  });

  it('parks the probe and records the ledger (unresolved) when contradictionMode is probe', async () => {
    // Probe mode DEFERS: the route asks a reconciliation question, suppresses this turn's writes, and
    // persists BOTH the parked pendingContradiction and the ledger entry. This is the probe-mode
    // persist path the flag-mode test above never exercises.
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        activeQuestionKey: 'q1',
        base: {
          ...baseCtx.base,
          existingAnswers: [
            { slotKey: 'q1', value: 'junior', provenance: 'direct' as const, confidence: 0.7 },
            { slotKey: 'role', value: 'engineer', provenance: 'direct' as const, confidence: 0.8 },
          ],
          config: {
            ...baseCtx.base.config,
            contradictionMode: 'probe',
            contradictionEveryNTurns: 1,
          },
        },
      })
    );
    invokersMock.buildTurnInvokers.mockResolvedValue(contradictionInvokers());

    await drainSse(await POST(req({ message: 'senior manager' }), ctx));

    const persistArg = runMock.persistTurn.mock.calls[0]?.[0] as {
      pendingContradiction?: { slotKeys: string[] };
      raisedContradictions?: Array<{ key: string; slotKeys: string[]; resolution: string }>;
      upserts: unknown[];
    };
    // The parked probe is persisted (drives the next turn's resolution path)…
    expect(persistArg.pendingContradiction).toEqual(expect.objectContaining({ slotKeys: ['q1'] }));
    // …the ledger records it as unresolved (raised, awaiting the respondent's confirmation)…
    expect(persistArg.raisedContradictions).toEqual([
      expect.objectContaining({ key: 'q1', slotKeys: ['q1'], resolution: 'unresolved' }),
    ]);
    // …and this turn's answer write is suppressed (nothing recorded before confirmation).
    expect(persistArg.upserts).toEqual([]);
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

// ---------------------------------------------------------------------------
// kickoff turn: flags forced off (lines 140, 346, 351, 353, 355, 372, 373)
// ---------------------------------------------------------------------------
describe('kickoff turn flag overrides', () => {
  it('forces extraction, seriousnessGate, and sensitivityAwareness flags off on a kickoff turn', async () => {
    // Arrange: a context where sensitivity awareness and seriousness gate are config-enabled.
    // A kickoff carries no respondent answer — all three flags must be forced off.
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...baseCtx.base,
          config: {
            ...baseCtx.base.config,
            sensitivityAwareness: true,
            abuseThreshold: 1,
          },
        },
      })
    );

    // A seriousness invoker that would mutate state if called erroneously.
    const sensitivityStub = vi.fn(async () => ({ assessment: null, costUsd: 0 }));
    invokersMock.buildTurnInvokers.mockResolvedValue({
      ...stubInvokers(),
      detectSensitivity: sensitivityStub,
    });

    // Act: kickoff (no message).
    const res = await POST(req({ kickoff: true }), ctx);
    expect(res.status).toBe(200);
    await drainSse(res);

    // Assert: the invoker was built with sensitivityAware: false for kickoff turns
    // (no message to disclose — forcing it off prevents a spurious sensitivity flag).
    const invokerArgs = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      sensitivityAware: boolean;
    };
    expect(invokerArgs.sensitivityAware).toBe(false);

    // The userMessage persisted must be empty (kickoff carries no respondent text).
    expect(runMock.persistTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: '' }));
  });
});

// ---------------------------------------------------------------------------
// goal forwarded to invoker builder (line 458)
// ---------------------------------------------------------------------------
describe('version goal forwarded to invoker builder', () => {
  it('passes the version goal to buildTurnInvokers when set', async () => {
    // Arrange: meta.goal set — the adaptive selector uses it to pick the best next question.
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({ meta: { goal: 'Understand team dynamics' } })
    );

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    const args = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      goal?: string;
    };
    expect(args.goal).toBe('Understand team dynamics');
  });

  it('omits goal from buildTurnInvokers when not set', async () => {
    // Default loadedContext has meta: {} (no goal).
    await drainSse(await POST(req({ message: 'hi' }), ctx));

    const args = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      goal?: string;
    };
    expect(args.goal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// anonymous flag forwarded to invoker builder (line 460, 470)
// ---------------------------------------------------------------------------
describe('anonymous flag forwarded to invoker builder', () => {
  it('passes anonymous:true to buildTurnInvokers for an anonymous session', async () => {
    // Arrange: no cookie session, valid session token.
    setAuth(null);
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        session: { id: 'sess-1', status: 'active', versionId: 'v1', respondentUserId: null },
      })
    );

    await drainSse(await POST(req({ message: 'hello' }, { 'x-session-token': 'tok.sig' }), ctx));

    const args = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      anonymous?: boolean;
    };
    expect(args.anonymous).toBe(true);
  });

  it('omits anonymous from buildTurnInvokers for an authenticated session', async () => {
    // Default beforeEach: authenticated user — anonymous must be absent.
    await drainSse(await POST(req({ message: 'hello' }), ctx));

    const args = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      anonymous?: boolean;
    };
    expect(args.anonymous).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inspector frame (lines 313, 315, 460, 584, 626, 669, 787)
// ---------------------------------------------------------------------------
describe('preview turn inspector', () => {
  /** A context with isPreview=true and previewInspectorEnabled=true. */
  function inspectorContext() {
    const base = loadedContext();
    return loadedContext({
      session: {
        id: 'sess-1',
        status: 'active',
        versionId: 'v1',
        respondentUserId: USER,
        isPreview: true,
      },
      base: {
        ...base.base,
        config: { ...base.base.config, previewInspectorEnabled: true },
      },
    });
  }

  it('emits an inspector frame after the reply when inspectorCalls are populated', async () => {
    // Arrange: preview session + inspector on. Build invokers that push a call into
    // the recorder when the extractor fires — so inspectorCalls.length > 0.
    ctxMock.buildTurnContext.mockResolvedValue(inspectorContext());

    // Override buildTurnInvokers to capture the recordInspectorCall seam and call it.
    invokersMock.buildTurnInvokers.mockImplementation(
      async (opts: {
        recordInspectorCall?: (trace: {
          label: string;
          model: string;
          provider: string;
          latencyMs: number;
          costUsd: number;
          prompt: Array<{ role: string; content: string }>;
          response: string;
        }) => void;
      }) => {
        const inv = stubInvokers();
        // Simulate the extractor recording a trace via the inspector seam.
        inv.extractAnswers = vi.fn(async () => {
          opts.recordInspectorCall?.({
            label: 'Answer extraction',
            model: 'gpt-4o-mini',
            provider: 'openai',
            latencyMs: 42,
            costUsd: 0.0001,
            prompt: [{ role: 'user', content: 'test' }],
            response: '[]',
          });
          return { intents: [], costUsd: 0.0001 };
        });
        return inv;
      }
    );

    // Act
    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));

    // Assert: an 'inspector' frame is present after the 'content' frames.
    const eventNames = frames.map((f) => f.event);
    expect(eventNames).toContain('inspector');

    const inspectorFrame = frames.find((f) => f.event === 'inspector');
    const data = inspectorFrame!.data as {
      turnIndex: number;
      calls: Array<{ label: string }>;
    };
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0].label).toBe('Answer extraction');
    expect(data.turnIndex).toBe(0); // selectionRound === 0 in base context

    // Inspector frame must come after the last content frame.
    const lastContentIdx = eventNames.lastIndexOf('content');
    const inspectorIdx = eventNames.indexOf('inspector');
    expect(inspectorIdx).toBeGreaterThan(lastContentIdx);
  });

  it('does not emit an inspector frame when no calls were recorded (empty inspectorCalls)', async () => {
    // Arrange: inspector on, but invokers never call recordInspectorCall.
    ctxMock.buildTurnContext.mockResolvedValue(inspectorContext());
    // stubInvokers() does NOT call recordInspectorCall — inspectorCalls stays empty.

    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));

    expect(frames.map((f) => f.event)).not.toContain('inspector');
  });

  it('does not emit an inspector frame for a non-preview session (isPreview falsy)', async () => {
    // Default context: session has no isPreview → inspector off, frame never emitted.
    // Even if we push a fake call trace, the `inspectorOn` gate blocks the frame.
    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));
    expect(frames.map((f) => f.event)).not.toContain('inspector');
  });
});

// ---------------------------------------------------------------------------
// warning detail enrichment — seriousness (line 519-520) and contradiction
// explanation equals message branch (line 521-524)
// ---------------------------------------------------------------------------
describe('warning detail enrichment', () => {
  function seriousnessInvokers(reason: string) {
    return {
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: 'junk',
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
        verdict: { serious: false, reason },
        costUsd: 0,
      })),
      detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
    };
  }

  it('enriches a seriousness warning with the judge reason as detail', async () => {
    // Arrange: a non-serious response with a reason — the route enriches the warning frame.
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        activeQuestionKey: 'q1',
        base: {
          ...baseCtx.base,
          abuseStrikes: 0,
          config: { ...baseCtx.base.config, abuseThreshold: 4 },
        },
      })
    );
    invokersMock.buildTurnInvokers.mockResolvedValue(
      seriousnessInvokers('That answer is not plausible.')
    );

    // Act
    const frames = await drainSse(await POST(req({ message: 'junk' }), ctx));

    // Assert: the seriousness warning frame carries the judge's reason as `detail`.
    const seriousnessFrame = frames.find(
      (f) => f.event === 'warning' && (f.data as { code?: string }).code === 'seriousness'
    );
    expect(seriousnessFrame).toBeDefined();
    const data = seriousnessFrame!.data as { code: string; message: string; detail?: string };
    expect(data.detail).toBe('That answer is not plausible.');
  });

  it('omits detail on a contradiction warning when explanation equals the message (flag mode)', async () => {
    // In flag mode the explanation IS the warning message — no separate "Why?" detail needed.
    const baseCtx = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        activeQuestionKey: 'q1',
        base: {
          ...baseCtx.base,
          existingAnswers: [
            { slotKey: 'q1', value: 'junior', provenance: 'direct' as const, confidence: 0.7 },
            { slotKey: 'role', value: 'engineer', provenance: 'direct' as const, confidence: 0.8 },
          ],
          config: {
            ...baseCtx.base.config,
            contradictionMode: 'flag',
            contradictionEveryNTurns: 1,
          },
        },
      })
    );

    // Invoker whose contradiction explanation IS the warning message (flag mode pattern).
    invokersMock.buildTurnInvokers.mockResolvedValue({
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: 'senior',
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
            // explanation and message are THE SAME — the route must skip the detail field.
            explanation: 'Earlier said junior; now says senior',
            severity: 'medium' as const,
            confidence: 0.8,
          },
        ],
        costUsd: 0,
      })),
      refineAnswer: vi.fn(async () => ({ decisions: [], costUsd: 0 })),
      selectNext: vi.fn(async () => ({
        decision: { kind: 'ask', questionId: 'q1', rationale: 'x', costUsd: 0 },
      })),
      assessSeriousness: vi.fn(async () => ({
        verdict: { serious: true, reason: '' },
        costUsd: 0,
      })),
      detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
    });

    const frames = await drainSse(await POST(req({ message: 'senior manager' }), ctx));

    const contradictionFrame = frames.find(
      (f) => f.event === 'warning' && (f.data as { code?: string }).code === 'contradiction'
    );
    expect(contradictionFrame).toBeDefined();
    const data = contradictionFrame!.data as { code: string; message: string; detail?: string };
    // message === explanation → detail must be absent (the route skips the duplicate).
    expect(data.message).toBe('Earlier said junior; now says senior');
    expect(data.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// data_slot response branch — isReask / isFinalAttempt / goal / audience (lines 597, 610, 611, 618-620)
// ---------------------------------------------------------------------------
describe('data_slot response — phrasing inputs', () => {
  /** A context where data-slot mode is active and a re-ask scenario can be set up. */
  function reaskDataSlotContext(
    attempts: number,
    maxAttempts: number,
    currentFill?: { value: string; paraphrase: string; confidence: number }
  ) {
    const base = loadedContext();
    return loadedContext({
      meta: { goal: 'Assess team performance', audience: 'managers' },
      base: {
        ...base.base,
        config: { ...base.base.config, maxDataSlotAttempts: maxAttempts },
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
        dataSlotAnswered: currentFill
          ? [
              {
                dataSlotId: 'ds-1',
                value: currentFill.value,
                paraphrase: currentFill.paraphrase,
                confidence: currentFill.confidence,
              },
            ]
          : [],
        dataSlotAttempts: { 'ds-1': attempts },
      },
    });
  }

  it('threads goal and audience into data_slot phraser input when set in meta', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(reaskDataSlotContext(0, 3));
    // Standard stubInvokers: extraction returns empty, selectNext asks q1 (question path),
    // but the data-slot orchestrator takes over because dataSlots is non-empty.

    await drainSse(await POST(req({ message: 'tell me more' }), ctx));

    const input = (questionMock.streamQuestionMessage as Mock).mock.calls[0]?.[0]?.input as {
      goal?: string;
      audience?: string;
    };
    expect(input.goal).toBe('Assess team performance');
    expect(input.audience).toBe('managers');
  });

  it('passes isReask=true and currentUnderstanding when the slot is the active slot with a prior weak fill', async () => {
    // isReask is set by the real orchestrator when next.key === state.activeDataSlotKey.
    // Set activeDataSlotKey to match the only slot ('department') — the fill has low confidence
    // so it stays "unfilled" and the orchestrator will re-select it → isReask=true.
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        meta: { goal: 'Assess team performance', audience: 'managers' },
        base: {
          ...base.base,
          config: { ...base.base.config, maxDataSlotAttempts: 3 },
          // activeDataSlotKey matches the slot → the orchestrator marks it as a re-ask.
          activeDataSlotKey: 'department',
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
          dataSlotAnswered: [
            {
              dataSlotId: 'ds-1',
              value: 'Engineering',
              paraphrase: 'Works in Engineering',
              // Low confidence → slot stays unfilled → re-ask path.
              confidence: 0.4,
            },
          ],
          dataSlotAttempts: { 'ds-1': 1 },
        },
      })
    );

    await drainSse(await POST(req({ message: 'engineering' }), ctx));

    const input = (questionMock.streamQuestionMessage as Mock).mock.calls[0]?.[0]?.input as {
      isReask: boolean;
      currentUnderstanding?: string;
      isFinalAttempt?: boolean;
    };
    // The real orchestrator computed isReask=true because next.key===activeDataSlotKey.
    expect(input.isReask).toBe(true);
    // The route threads the prior fill's paraphrase as currentUnderstanding for the phraser.
    expect(input.currentUnderstanding).toBe('Works in Engineering');
    // attempts (1) + 1 = 2, maxAttempts = 3 → NOT the final attempt.
    expect(input.isFinalAttempt).toBeUndefined();
  });

  it('sets isFinalAttempt when the re-ask is the last allowed attempt', async () => {
    // attempts=2, maxAttempts=3 → attemptsForTarget(2) + 1 = 3 >= maxDataSlotAttempts(3) → isFinalAttempt.
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        meta: { goal: 'Assess team performance', audience: 'managers' },
        base: {
          ...base.base,
          config: { ...base.base.config, maxDataSlotAttempts: 3 },
          activeDataSlotKey: 'department',
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
          dataSlotAnswered: [
            {
              dataSlotId: 'ds-1',
              value: 'Engineering',
              paraphrase: 'Still unclear',
              confidence: 0.3,
            },
          ],
          dataSlotAttempts: { 'ds-1': 2 },
        },
      })
    );

    await drainSse(await POST(req({ message: 'engineering again' }), ctx));

    const input = (questionMock.streamQuestionMessage as Mock).mock.calls[0]?.[0]?.input as {
      isFinalAttempt?: boolean;
    };
    expect(input.isFinalAttempt).toBe(true);
  });

  it('omits isFinalAttempt on the first ask (not a re-ask)', async () => {
    // activeDataSlotKey is null → isReask=false → isFinalAttempt check is skipped.
    ctxMock.buildTurnContext.mockResolvedValue(reaskDataSlotContext(0, 3));

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    const input = (questionMock.streamQuestionMessage as Mock).mock.calls[0]?.[0]?.input as {
      isFinalAttempt?: boolean;
    };
    expect(input.isFinalAttempt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// data-slot candidate with parkPending flag (lines 381, 388, 393)
// ---------------------------------------------------------------------------
describe('data-slot candidate parkPending', () => {
  it('includes parkPending:true and attempts when slot hits the re-ask cap with low confidence', async () => {
    // Arrange: a slot with attempts >= maxDataSlotAttempts and confidence below threshold.
    const base = loadedContext();
    const MAX_ATTEMPTS = 3;
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          config: { ...base.base.config, maxDataSlotAttempts: MAX_ATTEMPTS },
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
          dataSlotAnswered: [
            {
              dataSlotId: 'ds-1',
              value: 'maybe marketing',
              paraphrase: 'unclear',
              // Low confidence → below DATA_SLOT_FILLED_THRESHOLD → parkPending
              confidence: 0.2,
            },
          ],
          // attempts === maxDataSlotAttempts → parkPending
          dataSlotAttempts: { 'ds-1': MAX_ATTEMPTS },
        },
      })
    );

    await drainSse(await POST(req({ message: 'I work in marketing maybe' }), ctx));

    // Assert: the invoker builder received a candidate with parkPending: true.
    const invokerArgs = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      dataSlotCandidates?: Array<{ key: string; parkPending?: boolean; attempts?: number }>;
    };
    const candidate = invokerArgs.dataSlotCandidates?.find((c) => c.key === 'department');
    expect(candidate?.parkPending).toBe(true);
    expect(candidate?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('includes mappedQuestionKeys when the slot has them', async () => {
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          dataSlots: [
            {
              id: 'ds-1',
              key: 'department',
              name: 'Department',
              description: 'Which department?',
              theme: 'role',
              ordinal: 0,
              weight: 1,
              mappedQuestionKeys: ['q1', 'q2'],
            },
          ],
          dataSlotAnswered: [],
          dataSlotAttempts: {},
        },
      })
    );

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    const invokerArgs = invokersMock.buildTurnInvokers.mock.calls[0]?.[0] as {
      dataSlotCandidates?: Array<{ key: string; mappedQuestionKeys?: string[] }>;
    };
    const candidate = invokerArgs.dataSlotCandidates?.find((c) => c.key === 'department');
    expect(candidate?.mappedQuestionKeys).toEqual(['q1', 'q2']);
  });
});

// ---------------------------------------------------------------------------
// adaptive slot embedding — fail-soft and lazy-ensure on data-slot adaptive (lines 228, 237, 267, 281-296)
// ---------------------------------------------------------------------------
describe('adaptive embedding lazy-ensure', () => {
  it('calls ensureVersionSlotsEmbedded when adaptive mode is on and strategy is adaptive', async () => {
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          config: { ...base.base.config, selectionStrategy: 'adaptive' },
        },
      })
    );

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // When adaptive flag is on AND selectionStrategy is 'adaptive', embeddings are ensured.
    expect(slotEmbedMock.ensureVersionSlotsEmbedded).toHaveBeenCalledWith('v1');
  });

  it('does not call ensureVersionSlotsEmbedded when strategy is not adaptive', async () => {
    // `adaptive` is now the default strategy, so set a non-adaptive one explicitly to exercise the
    // "no adaptive embedding" branch.
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          config: { ...base.base.config, selectionStrategy: 'sequential' },
        },
      })
    );
    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // ensureVersionSlotsEmbedded is only called by adaptive or prefilter paths.
    // With no adaptive strategy and no prefilter, it should not be called by the adaptive branch.
    // (It may be called by other paths if prefilter is on, but default context has prefilter off.)
    expect(slotEmbedMock.ensureVersionSlotsEmbedded).not.toHaveBeenCalled();
  });

  it('completes the turn fail-soft when adaptive slot embedding throws', async () => {
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          config: { ...base.base.config, selectionStrategy: 'adaptive' },
        },
      })
    );
    slotEmbedMock.ensureVersionSlotsEmbedded.mockRejectedValue(new Error('pgvector timeout'));

    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    expect(frames[frames.length - 1].event).toBe('done');
  });

  it('calls ensureVersionDataSlotsEmbedded when data-slot adaptive mode is active', async () => {
    // Arrange: data-slot mode + adaptive data-slot sub-flag both on.
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
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
          dataSlotAnswered: [],
          dataSlotAttempts: {},
        },
      })
    );

    await drainSse(await POST(req({ message: 'hi' }), ctx));

    // Data-slot adaptive path ensures data-slot embeddings.
    expect(dataSlotEmbedMock.ensureVersionDataSlotsEmbedded).toHaveBeenCalledWith('v1');
  });

  it('completes the turn fail-soft when data-slot adaptive embedding throws', async () => {
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
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
          dataSlotAnswered: [],
          dataSlotAttempts: {},
        },
      })
    );
    dataSlotEmbedMock.ensureVersionDataSlotsEmbedded.mockRejectedValue(
      new Error('embedder unavailable')
    );

    const res = await POST(req({ message: 'hi' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    expect(frames[frames.length - 1].event).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// abuse gate: abortSession called on threshold, persistAbuseStrikes + abortSession
// fail-soft swallows the error (lines 723-747)
// ---------------------------------------------------------------------------
describe('abuse gate: abort on threshold strike', () => {
  // Per gotcha #22: `abuse gate write failure` test sets persistAbuseStrikes to reject; the
  // outer vi.clearAllMocks() only clears call history, not mockRejectedValue implementations.
  // Reset here so abortSession can be reached (it's only called after persistAbuseStrikes succeeds).
  beforeEach(() => {
    sessionsMock.persistAbuseStrikes.mockReset().mockResolvedValue(undefined);
    sessionsMock.abortSession.mockReset().mockResolvedValue('aborted');
  });

  function thresholdAbusiveInvokers() {
    return {
      extractAnswers: vi.fn(async () => ({
        intents: [
          {
            slotKey: 'q1',
            questionType: 'free_text',
            value: 'nonsense',
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
        verdict: { serious: false, reason: 'Implausible answer' },
        costUsd: 0,
      })),
      detectSensitivity: vi.fn(async () => ({ assessment: null, costUsd: 0 })),
    };
  }

  function thresholdGateContext(abuseStrikes: number) {
    const base = loadedContext();
    return loadedContext({
      activeQuestionKey: 'q1',
      base: { ...base.base, abuseStrikes, config: { ...base.base.config, abuseThreshold: 4 } },
    });
  }

  it('calls abortSession with ABUSE_ABANDON_REASON and metadata when threshold is reached', async () => {
    invokersMock.buildTurnInvokers.mockResolvedValue(thresholdAbusiveInvokers());
    ctxMock.buildTurnContext.mockResolvedValue(thresholdGateContext(3)); // next strike is the 4th (threshold)

    await drainSse(await POST(req({ message: 'garbage' }), ctx));

    expect(sessionsMock.abortSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        reason: ABUSE_ABANDON_REASON,
        metadata: expect.objectContaining({
          strikes: 4,
          threshold: 4,
          judgeReason: 'Implausible answer',
        }),
      })
    );
    // persistAbuseStrikes runs before abortSession (call order).
    expect(sessionsMock.persistAbuseStrikes.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsMock.abortSession.mock.invocationCallOrder[0]
    );
  });

  it('still emits done when abortSession rejects (fail-soft)', async () => {
    invokersMock.buildTurnInvokers.mockResolvedValue(thresholdAbusiveInvokers());
    ctxMock.buildTurnContext.mockResolvedValue(thresholdGateContext(3));
    sessionsMock.abortSession.mockRejectedValue(new Error('abort write boom'));

    const res = await POST(req({ message: 'garbage' }), ctx);
    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    expect(frames[frames.length - 1].event).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// reasoning stream: emits dataSlots to builder in data-slot mode (line 544)
// and non-empty trace branch (line 547)
// ---------------------------------------------------------------------------
describe('reasoning stream in data-slot mode', () => {
  it('passes dataSlots to buildReasoningTrace when in data-slot mode', async () => {
    const base = loadedContext();
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        base: {
          ...base.base,
          config: {
            ...base.base.config,
            reasoningStreamEnabled: true,
            reasoningStreamPersist: false,
          },
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
          dataSlotAnswered: [],
          dataSlotAttempts: {},
        },
      })
    );
    const steps = [{ kind: 'answer_captured', label: 'Captured department', tone: 'positive' }];
    reasoningMock.buildReasoningTrace.mockReturnValue(steps);

    const frames = await drainSse(await POST(req({ message: 'hi' }), ctx));

    // In data-slot mode the builder receives dataSlots so it can name them in the trace.
    const builderCall = reasoningMock.buildReasoningTrace.mock.calls[0];
    const opts = builderCall?.[1] as { dataSlots?: Array<{ key: string }> };
    expect(opts.dataSlots).toBeDefined();
    expect(opts.dataSlots![0].key).toBe('department');

    // The reasoning frame is emitted.
    expect(frames.map((f) => f.event)).toContain('reasoning');
  });
});

describe('retry dedup-and-replay (F7.x)', () => {
  const KEY = '11111111-1111-4111-8111-111111111111';

  it('replays a turn already persisted under the key instead of re-running it', async () => {
    // Arrange: the attempt's key resolves to a saved turn (the narrow drop-after-persist case).
    transcriptMock.findTurnByIdempotencyKey.mockResolvedValue({
      id: 'turn-prior',
      agentResponse: 'Your saved reply.',
      warnings: [{ code: 'contradiction', message: 'Noticed earlier.', detail: 'why' }],
      reasoning: [],
    });

    // Act
    const frames = await drainSse(await POST(req({ message: 'hi', idempotencyKey: KEY }), ctx));

    // Assert: the lookup used this session + key.
    expect(transcriptMock.findTurnByIdempotencyKey).toHaveBeenCalledWith('sess-1', KEY);

    // The saved reply streams back (reassembled from the chunked content frames).
    const content = frames
      .filter((f) => f.event === 'content')
      .map((f) => (f.data as { delta: string }).delta)
      .join('');
    expect(content).toBe('Your saved reply.');

    // The persisted warning replays too, and the frame order matches a live turn.
    expect(frames.map((f) => f.event)).toEqual(['start', 'warning', 'content', 'done']);

    // Crucially: NO re-run and NO duplicate persist.
    expect(runMock.persistTurn).not.toHaveBeenCalled();
  });

  it('replays the saved reasoning trace and a detail-less warning in live frame order', async () => {
    // The other replay shape: a turn whose saved trace is non-empty and whose warning carried no
    // detail — exercises the reasoning-frame branch and the omitted-detail branch of the replay.
    const steps = [{ label: 'Re-read the prior answers', detail: null }];
    transcriptMock.findTurnByIdempotencyKey.mockResolvedValue({
      id: 'turn-prior',
      agentResponse: 'Replayed with reasoning.',
      warnings: [{ code: 'support', message: 'Reach a human anytime.' }],
      reasoning: steps,
    });

    const frames = await drainSse(await POST(req({ message: 'hi', idempotencyKey: KEY }), ctx));

    // Reasoning frame appears (and before content), carrying the saved steps verbatim.
    expect(frames.map((f) => f.event)).toEqual([
      'start',
      'warning',
      'reasoning',
      'content',
      'done',
    ]);
    const reasoningFrame = frames.find((f) => f.event === 'reasoning');
    expect((reasoningFrame!.data as { steps: unknown[] }).steps).toEqual(steps);

    // The detail-less warning replays without a `detail` field.
    const warningFrame = frames.find((f) => f.event === 'warning');
    expect(warningFrame!.data).toEqual({
      type: 'warning',
      code: 'support',
      message: 'Reach a human anytime.',
    });
    expect(warningFrame!.data).not.toHaveProperty('detail');

    expect(runMock.persistTurn).not.toHaveBeenCalled();
  });

  it('runs fresh (and persists with the key) when the key has no prior turn — the common retry', async () => {
    // Arrange: default mock already returns null (no prior turn under the key).
    // Act
    const frames = await drainSse(await POST(req({ message: 'hi', idempotencyKey: KEY }), ctx));

    // Assert: a real turn ran and was persisted, stamped with the key for a future retry to dedup on.
    expect(frames.map((f) => f.event)).toContain('content');
    expect(runMock.persistTurn).toHaveBeenCalledTimes(1);
    expect(runMock.persistTurn.mock.calls[0][0]).toMatchObject({ idempotencyKey: KEY });
  });

  it('rejects a non-UUID idempotency key at validation (400)', async () => {
    const res = await POST(req({ message: 'hi', idempotencyKey: 'not-a-uuid' }), ctx);
    expect(res.status).toBe(400);
    expect(transcriptMock.findTurnByIdempotencyKey).not.toHaveBeenCalled();
  });
});
