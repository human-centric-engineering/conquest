/**
 * Unit tests for the streaming routing-analysis route (Conditional Topics, P17.4).
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/analyse/stream/route.ts
 *
 * Every collaborator is mocked at the module boundary and `sseResponse` is captured so the driving
 * generator can be drained and its emitted events asserted — the route's real work (dispatching,
 * re-validating, persisting, recording provenance) happens inside that generator, so a test that
 * never drains it asserts nothing.
 *
 * Pinned here:
 *   - the per-admin rate cap (`routingAnalysisLimiter`) short-circuits before any paid work starts,
 *     and its 429 carries the standard rate-limit envelope. The limiter holds MODULE-LEVEL state
 *     (an LRU cache keyed on admin id), so each rate-limit test resets it explicitly rather than
 *     relying on `vi.clearAllMocks()`, which only clears mock call history — not the cache.
 *   - a missing/questionless version and an unseeded analyst agent both throw `NotFoundError`
 *     before any dispatch;
 *   - **the run never forks** — a proposal is inert, so a launched version is written to directly;
 *   - a dispatch failure surfaces as a terminal `error` event (not a throw — the response is already
 *     streaming) and records a FAILED `recordAiRun` with the dispatcher's error message;
 *   - a malformed capability payload is re-validated and rejected rather than persisted;
 *   - the terminal `done` phase sequence and its handler-derived fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth: (handler: unknown) => handler,
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

// `createRateLimitResponse` is wrapped (not replaced) so it still builds the real 429 envelope —
// only spied on so a test can assert it was actually invoked. `createRateLimiter` is left
// untouched, which matters: `_lib/rate-limit.ts` (NOT mocked below) calls it at module load to
// build every limiter it exports, including `routingAnalysisLimiter`.
vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...real, createRateLimitResponse: vi.fn(real.createRateLimitResponse) };
});

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));

// `@/app/api/v1/app/questionnaires/_lib/rate-limit` is deliberately NOT mocked: this is the ONE
// place in the app-route test suite that exercises the routing-analysis limiter for real. It is
// module-level state (an LRU cache keyed on admin id, built at import time) that `vi.clearAllMocks()`
// never touches — pattern #11 — so every test that consumes the budget resets the token itself.

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-draft', () => ({
  buildRoutingAnalysisInput: vi.fn(),
  saveTopicDraft: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

// The fork writer is NOT imported by this route. Mocked so that if it ever were, the assertion
// below would catch it rather than the test silently passing on a missing module.
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({
  forkVersionIfLaunched: vi.fn(),
}));

// Capture the generator handed to sseResponse so tests can drain it.
let capturedGen: AsyncGenerator<unknown> | undefined;
vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn((events: AsyncGenerator<unknown>) => {
    capturedGen = events;
    return new Response('sse', { status: 200 });
  }),
}));

// ─── Deferred imports (after vi.mock) ────────────────────────────────────────

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/analyse/stream/route')) as {
    POST: AnyRouteHandler;
  };

import { prisma } from '@/lib/db/client';
import { routingAnalysisLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  buildRoutingAnalysisInput,
  saveTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

const EXISTING_TOPIC = {
  id: 'topic-existing',
  key: 'wellbeing',
  label: 'Wellbeing',
  description: null,
  phase: 'conditional' as const,
  criteria: 'Respondent mentions stress',
  depth: 'full' as const,
  members: { questionKeys: ['q1'], dataSlotKeys: [] },
  ordinal: 0,
  source: 'manual' as const,
};

const AGENT = {
  id: 'agent-routing-1',
  provider: 'openai',
  model: 'gpt-5.4',
  fallbackProviders: ['anthropic'],
};

const INPUT = {
  goal: 'Assess spiritual development',
  audience: undefined,
  questions: [{ key: 'q1', prompt: 'How connected do you feel to your higher self?' }],
  dataSlots: [{ key: 'ds1', name: 'Mood' }],
  existingTopics: [EXISTING_TOPIC],
  documents: [],
};

const ANALYSIS = {
  topics: [
    {
      key: 'wellbeing',
      label: 'Wellbeing',
      phase: 'conditional' as const,
      criteria: 'Respondent mentions stress',
      depth: 'full' as const,
      questionKeys: ['q1'],
      dataSlotKeys: [],
      rationale: 'Stress is discussed at length in the instructions.',
      sourceQuote: 'Ask about stress only if raised.',
    },
  ],
  rules: [],
  gaps: [
    {
      sourceQuote: 'Use judgement for respondents outside these categories.',
      explanation: 'Too vague to test mechanically.',
    },
  ],
  summary: 'One conditional topic covering stress.',
  fromDocument: true,
};

const SAVED_DRAFT = {
  v: 1 as const,
  topics: [
    {
      key: 'wellbeing',
      label: 'Wellbeing',
      phase: 'conditional' as const,
      criteria: 'Respondent mentions stress',
      depth: 'full' as const,
      members: { questionKeys: ['q1'], dataSlotKeys: [] },
      rationale: 'Stress is discussed at length in the instructions.',
      sourceQuote: 'Ask about stress only if raised.',
      replacesExisting: true,
    },
  ],
  rules: [],
  gaps: [
    {
      sourceQuote: 'Use judgement for respondents outside these categories.',
      explanation: 'Too vague to test mechanically.',
    },
  ],
  summary: 'One conditional topic covering stress.',
  fromDocument: true,
  generatedAt: '2026-01-01T00:00:00.000Z',
};

function makeRequest(): NextRequest {
  return {
    url: `http://localhost:3000/api/v1/app/questionnaires/${QN_ID}/versions/${VID}/topics/analyse/stream`,
    headers: new Headers(),
    signal: new AbortController().signal,
    json: () => Promise.resolve({}),
  } as unknown as NextRequest;
}

function ctx() {
  return { params: Promise.resolve({ id: QN_ID, vid: VID }) };
}

async function invoke(): Promise<Response> {
  capturedGen = undefined;
  return POST(makeRequest(), ADMIN_SESSION, ctx());
}

/** Drain the captured SSE generator into a plain array of events. */
async function drain(): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  if (!capturedGen) return events;
  for await (const event of capturedGen) {
    events.push(event as Record<string, unknown>);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The limiter's LRU cache is module-level state that survives vi.clearAllMocks() — reset the
  // token explicitly so each test starts with a fresh window (pattern #11).
  routingAnalysisLimiter.reset('admin-1');

  (buildRoutingAnalysisInput as Mock).mockResolvedValue(INPUT);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: { result: ANALYSIS },
  });
  (saveTopicDraft as Mock).mockResolvedValue(SAVED_DRAFT);
});

// ─── Rate limiting ─────────────────────────────────────────────────────────────

describe('POST …/topics/analyse/stream — rate limiting', () => {
  it('returns 429 with the standard rate-limit envelope when the per-admin cap is hit, and does no work', async () => {
    // Exhaust the real limiter for this admin (ROUTING_ANALYSIS_RATE_LIMIT_MAX = 8/min).
    for (let i = 0; i < 8; i += 1) routingAnalysisLimiter.check('admin-1');

    const res = await invoke();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message: expect.any(String) },
    });
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(buildRoutingAnalysisInput).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('allows the request through again once the window is reset', async () => {
    for (let i = 0; i < 8; i += 1) routingAnalysisLimiter.check('admin-1');
    routingAnalysisLimiter.reset('admin-1');

    const res = await invoke();
    expect(res.status).toBe(200);
    expect(buildRoutingAnalysisInput).toHaveBeenCalled();
  });
});

// ─── Pre-stream gates ─────────────────────────────────────────────────────────

describe('POST …/topics/analyse/stream — pre-stream gates', () => {
  it('throws NotFound when the version is missing or has no questions', async () => {
    (buildRoutingAnalysisInput as Mock).mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow(/not found or has no questions/i);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws NotFound when the Routing Analyst agent has not been seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow(/not configured/i);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── The run ──────────────────────────────────────────────────────────────────

describe('POST …/topics/analyse/stream — the run', () => {
  it('streams reading → analysing → saving → done', async () => {
    await invoke();
    const events = await drain();

    expect(events.map((e) => e.phase ?? e.type)).toEqual([
      'reading',
      'analysing',
      'saving',
      'done',
    ]);
  });

  it('never forks — a proposal is inert, so a launched version is written directly', async () => {
    await invoke();
    await drain();
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('passes the assembled input and the agent binding to the capability', async () => {
    await invoke();
    await drain();

    const [slug, args, context] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(slug).toBe('app_analyse_routing');
    expect(args).toMatchObject({
      questions: INPUT.questions,
      goal: INPUT.goal,
      dataSlots: INPUT.dataSlots,
      versionId: VID,
    });
    expect(context).toMatchObject({
      userId: 'admin-1',
      agentId: AGENT.id,
      entityContext: {
        routingAnalystAgent: { provider: 'openai', model: 'gpt-5.4' },
      },
    });
  });

  it('mentions the uploaded document in the reading phase when one is attached', async () => {
    (buildRoutingAnalysisInput as Mock).mockResolvedValue({
      ...INPUT,
      documents: [
        {
          role: 'primary',
          fileName: 'instructions.pdf',
          text: 'Routing: ask about stress only when raised.',
        },
      ],
    });

    await invoke();
    const events = await drain();
    expect(events[0].message).toContain('your uploaded document');

    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args).toMatchObject({
      documents: [expect.objectContaining({ fileName: 'instructions.pdf' })],
    });
  });

  it('counts the supporting documents in the reading phase, so the spend is not a surprise', async () => {
    // An admin who attached two memos and watches "Reading 12 questions and your uploaded
    // document…" has no way to tell whether the attach actually took.
    (buildRoutingAnalysisInput as Mock).mockResolvedValue({
      ...INPUT,
      documents: [
        { role: 'primary', fileName: 'bank.md', text: 'Q1…' },
        { role: 'supplementary', fileName: 'memo-a.md', text: 'Owners only.' },
        { role: 'supplementary', fileName: 'memo-b.md', text: 'Skip Part C.' },
      ],
    });

    await invoke();
    const events = await drain();

    expect(events[0].message).toContain('2 supporting documents');
  });

  it('says no document is attached when none is', async () => {
    await invoke();
    const events = await drain();
    expect(events[0].message).toContain('no source document is attached');
  });

  describe('what toProposedSet actually carries across', () => {
    // This projection is the ONLY place a validated RoutingAnalysisResult becomes the stored and
    // streamed ProposedTopicSet. Nothing else tested it: the Zod schema tests cover the input side
    // and the accept tests cover the output side, so a field the analyst returns and the accept
    // writes could still be dropped in the middle and every other test would pass. It was.
    it('carries fallbackTopicKeys and checkTopicPreference through to the saved draft', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: {
          result: {
            ...ANALYSIS,
            fallbackTopicKeys: ['wellbeing'],
            checkTopicPreference: ['wellbeing'],
          },
          costUsd: 0,
        },
      });

      await invoke();
      await drain();

      expect(saveTopicDraft).toHaveBeenCalledWith(
        VID,
        expect.objectContaining({
          fallbackTopicKeys: ['wellbeing'],
          checkTopicPreference: ['wellbeing'],
        })
      );
    });

    it('omits both when the analyst proposed neither', async () => {
      await invoke();
      await drain();

      const saved = (saveTopicDraft as Mock).mock.calls[0][1];
      expect(saved).not.toHaveProperty('fallbackTopicKeys');
      expect(saved).not.toHaveProperty('checkTopicPreference');
    });

    it('drops a settings key naming no proposed topic', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: {
          result: { ...ANALYSIS, fallbackTopicKeys: ['wellbeing', 'not_a_topic'] },
          costUsd: 0,
        },
      });

      await invoke();
      await drain();

      const saved = (saveTopicDraft as Mock).mock.calls[0][1];
      expect(saved.fallbackTopicKeys).toEqual(['wellbeing']);
    });

    it('corrects light depth on an always-run topic BEFORE persisting or streaming', async () => {
      // The correction must happen here, not only on the DB read path: this object is both saved
      // and streamed, so a card rendering the streamed draft would otherwise show — and accept —
      // an opening set to Light.
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: {
          result: {
            ...ANALYSIS,
            topics: [
              {
                ...ANALYSIS.topics[0],
                key: 'opening',
                label: 'Opening',
                phase: 'opening' as const,
                criteria: null,
                depth: 'light' as const,
                questionKeys: ['q1', 'q2', 'q3', 'q4'],
              },
            ],
          },
          costUsd: 0,
        },
      });

      await invoke();
      await drain();

      const saved = (saveTopicDraft as Mock).mock.calls[0][1];
      expect(saved.topics[0].depth).toBe('full');
      expect(saved.depthCorrectedKeys).toEqual(['opening']);
    });
  });

  it('persists the draft and reports replacedCount/uncoveredQuestionCount on done', async () => {
    await invoke();
    const events = await drain();

    expect(saveTopicDraft).toHaveBeenCalledWith(
      VID,
      expect.objectContaining({
        topics: expect.arrayContaining([expect.objectContaining({ key: 'wellbeing' })]),
        gaps: [
          {
            sourceQuote: 'Use judgement for respondents outside these categories.',
            explanation: 'Too vague to test mechanically.',
          },
        ],
      })
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      versionId: VID,
      draft: SAVED_DRAFT,
      // wellbeing collides with an existing topic key → replacesExisting.
      replacedCount: 1,
      // q1 is covered by the proposed topic → nothing left uncovered.
      uncoveredQuestionCount: 0,
    });
  });

  it('reports an uncovered question the proposal left homeless', async () => {
    (buildRoutingAnalysisInput as Mock).mockResolvedValue({
      ...INPUT,
      questions: [...INPUT.questions, { key: 'q2', prompt: 'A second, unrouted question.' }],
    });
    (saveTopicDraft as Mock).mockResolvedValue(SAVED_DRAFT); // only covers q1

    await invoke();
    const events = await drain();
    expect(events.at(-1)).toMatchObject({ type: 'done', uncoveredQuestionCount: 1 });
  });

  it('records provenance and an audit entry on success', async () => {
    await invoke();
    await drain();

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'version',
        subjectId: VID,
        versionId: VID,
        kind: 'routing_analysis',
        status: 'succeeded',
        triggeredByUserId: 'admin-1',
        detail: expect.objectContaining({
          topicCount: 1,
          conditionalCount: 1,
          ruleCount: 0,
          gapCount: 1,
          usedDocument: false,
        }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_topics.analyse', entityId: VID })
    );
  });
});

// ─── Failure paths ────────────────────────────────────────────────────────────

describe('POST …/topics/analyse/stream — failures', () => {
  it('emits a terminal error (not a throw) when the dispatch fails, and persists nothing', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured.' },
    });

    const res = await invoke();
    // The response has already been handed back as a stream, so a failure cannot be a 5xx.
    expect(res.status).toBe(200);

    const events = await drain();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'provider_unavailable',
      message: 'No provider configured.',
    });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });

  it('records a FAILED run with the dispatcher error message when the dispatch fails', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured.' },
    });

    await invoke();
    await drain();

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'routing_analysis',
        status: 'failed',
        subjectId: VID,
        versionId: VID,
        error: 'No provider configured.',
        triggeredByUserId: 'admin-1',
      })
    );
  });

  it('falls back to a default code/message when the dispatcher error is empty', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({ success: false, error: undefined });

    await invoke();
    const events = await drain();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'ROUTING_ANALYSIS_FAILED',
      message: 'The routing analysis could not be completed.',
    });
  });

  it('rejects a malformed capability payload rather than writing it', async () => {
    // A capability that changed shape must fail here, not persist half-formed rows.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { topics: [{ key: 'ego' }] } },
    });

    await invoke();
    const events = await drain();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ROUTING_ANALYSIS_INVALID' });
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });

  it('records a FAILED run when the payload is malformed, same as a dispatch failure', async () => {
    // F17.19 Phase 3 relies on `routing_analysis` AppAiRun existence as the "already tried" signal
    // for the Topics tab's auto-trigger — a shape failure that recorded nothing would look
    // identical to "never attempted" and auto-fire again on every visit.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { topics: [{ key: 'ego' }] } },
    });

    await invoke();
    await drain();

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'version',
        subjectId: VID,
        versionId: VID,
        kind: 'routing_analysis',
        status: 'failed',
        triggeredByUserId: 'admin-1',
      })
    );
  });

  it('rejects a payload with no result at all', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({ success: true, data: {} });

    await invoke();
    const events = await drain();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ROUTING_ANALYSIS_INVALID' });
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });

  it('rejects a conditional topic proposed with no criteria, before it reaches the draft', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        result: {
          topics: [
            {
              key: 'homeless_conditional',
              label: 'Homeless',
              phase: 'conditional',
              criteria: null,
              questionKeys: [],
              dataSlotKeys: [],
              rationale: 'No criteria supplied.',
            },
          ],
          rules: [],
          summary: 'One bad topic.',
          fromDocument: false,
        },
      },
    });

    await invoke();
    const events = await drain();
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ROUTING_ANALYSIS_INVALID' });
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });
});
