/**
 * Integration test: questionnaire answer-extraction preview route (F4.2).
 *
 * Exercises the POST handler with the DB seam (`prisma`) and the capability
 * dispatcher mocked: gate order (404 master-flag-off before auth; 404 sub-flag-off
 * after auth), 401/403, scope-404, unknown-active-key 400, body validation, the
 * rate-limit 429, the capability wiring (active + side-effect intents), and the
 * fail-soft empty-intents path. The extractor capability itself is tested
 * separately (answer-capability.test.ts); this pins the route → context-builder →
 * dispatch wiring.
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

// Per-admin LLM sub-cap. Mock so tests don't consume the real window and the 429
// path is drivable. Default: allow; a test overrides per-call to deny.
const rateLimitMock = vi.hoisted(() => ({
  answerExtractionLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/extract-answer/route';

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/extract-answer';

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

/** A version with one section: full_name (free_text) + city (free_text). */
function versionRow() {
  return {
    id: 'v1',
    sections: [
      {
        id: 's1',
        questions: [
          {
            id: 'q1-id',
            key: 'full_name',
            type: 'free_text',
            typeConfig: null,
            prompt: 'What is your name?',
            guidelines: null,
            required: true,
          },
          {
            id: 'q2-id',
            key: 'city',
            type: 'free_text',
            typeConfig: null,
            prompt: 'Where do you live?',
            guidelines: null,
            required: false,
          },
        ],
      },
    ],
  };
}

const AGENT_ROW = {
  id: 'agent-1',
  provider: '',
  model: '',
  fallbackProviders: [],
};

/** A valid dispatch result with one active answer + one side-effect. */
function dispatchSuccess() {
  return {
    success: true,
    data: {
      droppedCount: 0,
      intents: [
        {
          slotKey: 'full_name',
          questionType: 'free_text',
          value: 'Dana',
          confidence: 0.95,
          provenance: 'direct',
          rationale: 'r',
          isActiveQuestion: true,
          sourceQuote: 'Dana',
        },
        {
          slotKey: 'city',
          questionType: 'free_text',
          value: 'Leeds',
          confidence: 0.8,
          provenance: 'inferred',
          rationale: 'r',
          isActiveQuestion: false,
        },
      ],
    },
  };
}

const VALID_BODY = { activeQuestionKey: 'full_name', userMessage: 'I am Dana from Leeds' };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(dispatchSuccess());
  rateLimitMock.answerExtractionLimiter.check.mockReturnValue({
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
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe('body validation', () => {
  it('rejects a missing userMessage', async () => {
    const res = await POST(req({ activeQuestionKey: 'full_name' }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects an empty userMessage', async () => {
    const res = await POST(req({ activeQuestionKey: 'full_name', userMessage: '' }), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized recentMessages array', async () => {
    const res = await POST(
      req({ ...VALID_BODY, recentMessages: Array(51).fill('x') }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
  });

  it('400s when activeQuestionKey is not a question in this version', async () => {
    const res = await POST(req({ activeQuestionKey: 'ghost', userMessage: 'hi' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    // Distinct from a missing version (404) — the dispatch never runs.
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('429s when the per-admin sub-cap is exhausted (before dispatch)', async () => {
    rateLimitMock.answerExtractionLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      // `reset` is a Unix timestamp in SECONDS (matches the real limiter), so a
      // future Retry-After computation gets a sane value, not a ms-epoch.
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('extraction wiring', () => {
  it('returns active + side-effect intents with a summary', async () => {
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.intents).toHaveLength(2);
    expect(body.data.summary).toMatchObject({ activeAnswerCount: 1, sideEffectCount: 1 });
  });

  it("reports the capability's real droppedCount in the summary (not a hardcoded 0)", async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: { droppedCount: 3, intents: dispatchSuccess().data.intents },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.summary.droppedCount).toBe(3);
  });

  it('dispatches with the candidate pool and the answer-extractor agent binding', async () => {
    await POST(req(VALID_BODY), ctx(PARAMS));
    const [slug, args, context] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_extract_answer_slots');
    expect(args.activeQuestionKey).toBe('full_name');
    // Candidate pool carries both slots (active + the unanswered one).
    expect(args.candidateSlots.map((s: { key: string }) => s.key).sort()).toEqual([
      'city',
      'full_name',
    ]);
    expect(context.agentId).toBe('agent-1');
    expect(context.entityContext.answerExtractorAgent).toMatchObject({ provider: '', model: '' });
  });

  it('excludes an already-answered slot from the candidate pool but keeps the active one', async () => {
    await POST(req({ ...VALID_BODY, answered: [{ key: 'city' }] }), ctx(PARAMS));
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    // `city` is answered → dropped; `full_name` (active) stays.
    expect(args.candidateSlots.map((s: { key: string }) => s.key)).toEqual(['full_name']);
    expect(args.answered).toEqual([{ slotKey: 'city', confidence: null }]);
  });

  it('is fail-soft: a capability error yields empty intents + a diagnostic, not a 5xx', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'extraction_failed', message: 'boom' },
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.intents).toEqual([]);
    expect(body.data.diagnostic).toBe('extraction_failed');
    expect(body.data.summary).toMatchObject({ activeAnswerCount: 0, sideEffectCount: 0 });
  });

  it('is fail-soft when the dispatch succeeds but carries no data', async () => {
    // The other arm of `!dispatch.success || !dispatch.data` — a success with an
    // absent payload still takes the empty-intents path rather than 500ing.
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: undefined,
    });
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.intents).toEqual([]);
    expect(body.data.diagnostic).toBe('extraction_failed');
  });

  it('404s when the answer-extractor agent is not seeded', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST(req(VALID_BODY), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
