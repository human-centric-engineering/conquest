/**
 * Integration test: questionnaire completion action route (F4.5).
 *
 * Exercises the POST handler with the DB seam (`prisma`), the answer-slot persistence
 * seam (`_lib/answer-slots`), and the capability dispatcher mocked: gate order, the
 * accept/hold resolution, the completion-sweep wiring (run only on an eligible accept,
 * gated by the per-questionnaire contradiction mode, fail-soft), and the active→completed
 * transition (only on a clean submit). The pure resolution logic is unit-tested separately
 * (completion-logic.test.ts) and the seam in answer-slot-persistence.test.ts; this
 * pins the route's orchestration.
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
  completionLimiter: {
    check: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 })),
  },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => rateLimitMock);

const slotsMock = vi.hoisted(() => ({
  getOrCreatePreviewSession: vi.fn(() => Promise.resolve('sess-preview')),
  upsertAnswerSlot: vi.fn(() => Promise.resolve('ans-x')),
  markSessionCompleted: vi.fn(() => Promise.resolve('completed')),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/answer-slots', () => slotsMock);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/complete/route';

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const URL = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/complete';

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

function setAuth(sessionVal: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(sessionVal);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

/** One required + one optional slot. `config: null` → defaults (coverage 1 / min 0). */
function versionRow() {
  return {
    id: 'v1',
    config: null,
    sections: [
      {
        id: 's1',
        ordinal: 0,
        questions: [
          {
            id: 'q1-id',
            key: 'goal',
            ordinal: 0,
            weight: 1,
            required: true,
            type: 'free_text',
            typeConfig: null,
            prompt: 'What is your goal?',
            guidelines: null as string | null,
            tags: [],
          },
          {
            id: 'q2-id',
            key: 'budget',
            ordinal: 1,
            weight: 1,
            required: false,
            type: 'numeric',
            typeConfig: null,
            prompt: 'What is your budget?',
            guidelines: null as string | null,
            tags: [],
          },
        ],
      },
    ],
  };
}

/** Build one question row in the shape buildSelectionContext/buildContradictionContext read. */
function qRow(key: string, ordinal: number, required: boolean) {
  return {
    id: `${key}-id`,
    key,
    ordinal,
    weight: 1,
    required,
    type: 'free_text',
    typeConfig: null,
    prompt: `Prompt for ${key}?`,
    guidelines: null as string | null,
    tags: [],
  };
}

/** A full config row (toConfigView reads every CONFIG_SELECT field). */
function configRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

const AGENT_ROW = { id: 'agent-1', provider: '', model: '', fallbackProviders: [] };

function dispatchFinding() {
  return {
    success: true,
    data: {
      droppedCount: 0,
      findings: [
        {
          slotKeys: ['goal', 'budget'],
          explanation: 'Goal and budget conflict.',
          severity: 'high',
          confidence: 0.9,
        },
      ],
    },
  };
}

/** Both questions answered → full coverage, required satisfied → offer. */
function acceptBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'accept',
    answers: [
      { key: 'goal', value: 'launch', confidence: 0.9 },
      { key: 'budget', value: 1000, confidence: 0.8 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow());
  prismaMock.aiAgent.findUnique.mockResolvedValue(AGENT_ROW);
  dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue(dispatchFinding());
  slotsMock.getOrCreatePreviewSession.mockResolvedValue('sess-preview');
  slotsMock.upsertAnswerSlot.mockResolvedValue('ans-x');
  slotsMock.markSessionCompleted.mockResolvedValue('completed');
  rateLimitMock.completionLimiter.check.mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0,
  });
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await POST(req(acceptBody()), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await POST(req(acceptBody()), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect((await POST(req(acceptBody()), ctx(PARAMS))).status).toBe(404);
  });

  it('rejects an invalid action', async () => {
    const res = await POST(req(acceptBody({ action: 'maybe' })), ctx(PARAMS));
    expect(res.status).toBe(400);
  });

  it('429s when the per-admin sub-cap is exhausted on the paid sweep path (before dispatch)', async () => {
    // The limiter gates only the paid sweep dispatch, so the 429 surfaces on an
    // eligible accept that would run the sweep (mode flag + detection enabled).
    rateLimitMock.completionLimiter.check.mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await POST(req(acceptBody({ mode: 'flag' })), ctx(PARAMS));
    expect(res.status).toBe(429);
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('does NOT consume the sub-cap on a free hold (no paid sweep)', async () => {
    const res = await POST(req(acceptBody({ action: 'hold', mode: 'flag' })), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(rateLimitMock.completionLimiter.check).not.toHaveBeenCalled();
  });

  it('does NOT consume the sub-cap when mode is off (no sweep dispatched)', async () => {
    const res = await POST(req(acceptBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(rateLimitMock.completionLimiter.check).not.toHaveBeenCalled();
  });
});

describe('accept → submit', () => {
  it('submits and completes the session when eligible and the sweep is off (mode off)', async () => {
    // No body mode → config null → contradiction mode resolves to off → no sweep.
    const res = await POST(req(acceptBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution.kind).toBe('submit');
    expect(body.data.status).toBe('completed');
    expect(slotsMock.markSessionCompleted).toHaveBeenCalledWith('sess-preview');
    // No sweep ran (mode off).
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('seeds each supplied answer into the preview session', async () => {
    await POST(req(acceptBody()), ctx(PARAMS));
    expect(slotsMock.getOrCreatePreviewSession).toHaveBeenCalledWith('v1');
    expect(slotsMock.upsertAnswerSlot).toHaveBeenCalledTimes(2);
    expect(slotsMock.upsertAnswerSlot).toHaveBeenCalledWith(
      'sess-preview',
      'q1-id',
      expect.objectContaining({ value: 'launch', provenance: 'direct' })
    );
  });

  it('submits when the sweep runs clean (mode flag, no contradictions)', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: true,
      data: { droppedCount: 0, findings: [] },
    });
    const res = await POST(req(acceptBody({ mode: 'flag' })), ctx(PARAMS));
    const body = await res.json();
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(body.data.resolution.kind).toBe('submit');
    expect(body.data.status).toBe('completed');
    expect(slotsMock.markSessionCompleted).toHaveBeenCalled();
  });
});

describe('accept → hold for review (sweep found contradictions)', () => {
  it('holds, leaves the session active, and returns the findings', async () => {
    const res = await POST(req(acceptBody({ mode: 'flag' })), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(body.data.resolution.kind).toBe('hold_for_review');
    expect(body.data.resolution.contradictionCount).toBe(1);
    expect(body.data.status).toBe('active');
    expect(body.data.findings).toHaveLength(1);
    expect(slotsMock.markSessionCompleted).not.toHaveBeenCalled();
  });

  it('dispatches the sweep at completion-sweep scope (compareWindow all)', async () => {
    await POST(req(acceptBody({ mode: 'flag', windowN: 2 })), ctx(PARAMS));
    const [slug, args] = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0];
    expect(slug).toBe('app_detect_contradictions');
    // The sweep runs in flag mode; windowN passes through but the completion sweep
    // compares all answers regardless (asserted via the pure scheduler's behaviour).
    expect(args.mode).toBe('flag');
    expect(args.answers).toHaveLength(2);
  });
});

describe('accept → fail-soft', () => {
  it('treats a failed sweep as clean and still submits (with a diagnostic)', async () => {
    dispatchMock.capabilityDispatcher.dispatch.mockResolvedValue({
      success: false,
      error: { code: 'detection_failed', message: 'boom' },
    });
    const res = await POST(req(acceptBody({ mode: 'flag' })), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.resolution.kind).toBe('submit');
    expect(body.data.status).toBe('completed');
    expect(body.data.diagnostic).toBe('detection_failed');
    expect(slotsMock.markSessionCompleted).toHaveBeenCalled();
  });

  it('404s when the detector agent is missing on an eligible flag-mode accept', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await POST(req(acceptBody({ mode: 'flag' })), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(slotsMock.markSessionCompleted).not.toHaveBeenCalled();
  });
});

describe('hold + blocked', () => {
  it('continues on hold, leaving the session active and running no sweep', async () => {
    const res = await POST(req(acceptBody({ action: 'hold', mode: 'flag' })), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.resolution.kind).toBe('continue');
    expect(body.data.status).toBe('active');
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(slotsMock.markSessionCompleted).not.toHaveBeenCalled();
  });

  it('refuses to submit on accept while a required question is unanswered', async () => {
    const res = await POST(
      req({ action: 'accept', answers: [{ key: 'budget', value: 1000 }] }),
      ctx(PARAMS)
    );
    const body = await res.json();
    expect(body.data.assessment.kind).toBe('blocked_on_required');
    expect(body.data.resolution.kind).toBe('continue');
    expect(body.data.status).toBe('active');
    // No sweep, no submit — accept can't bypass the required gate.
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(slotsMock.markSessionCompleted).not.toHaveBeenCalled();
  });
});

describe('sweep input shaping (hardening)', () => {
  it('dispatches the sweep with ONLY the answered slots, not the full version slot set', async () => {
    // Version with an extra UNANSWERED optional slot; coverageThreshold 0.5 so two of
    // three answered still offers. The detector should receive only goal + budget.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      config: configRow({ coverageThreshold: 0.5 }),
      sections: [
        {
          id: 's1',
          ordinal: 0,
          questions: [qRow('goal', 0, true), qRow('budget', 1, false), qRow('extra', 2, false)],
        },
      ],
    });

    await POST(
      req({
        action: 'accept',
        mode: 'flag',
        answers: [
          { key: 'goal', value: 'launch' },
          { key: 'budget', value: 1000 },
        ],
      }),
      ctx(PARAMS)
    );

    expect(dispatchMock.capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const args = dispatchMock.capabilityDispatcher.dispatch.mock.calls[0][1];
    expect(args.slots.map((s: { key: string }) => s.key).sort()).toEqual(['budget', 'goal']);
    // The unanswered 'extra' slot is trimmed out — it can't contradict anything.
    expect(args.slots.map((s: { key: string }) => s.key)).not.toContain('extra');
  });

  it('skips an oversized sweep with a diagnostic rather than fail-soft submitting silently', async () => {
    // A version larger than the detector's hard cap (MAX_CONTRADICTION_ANSWERS = 300),
    // fully answered → offer. The sweep can't run; the route must say so explicitly.
    const N = 301;
    const questions = Array.from({ length: N }, (_, i) => qRow(`q${i}`, i, false));
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      config: null,
      sections: [{ id: 's1', ordinal: 0, questions }],
    });
    const answers = Array.from({ length: N }, (_, i) => ({ key: `q${i}`, value: i }));

    const res = await POST(req({ action: 'accept', mode: 'flag', answers }), ctx(PARAMS));
    const body = await res.json();

    // No doomed dispatch, an explicit diagnostic, and the sub-cap is not consumed.
    expect(dispatchMock.capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(rateLimitMock.completionLimiter.check).not.toHaveBeenCalled();
    expect(body.data.diagnostic).toBe('sweep_skipped_oversized');
    // Fail-soft: the wrap-up still submits (consistent with the design), but visibly.
    expect(body.data.resolution.kind).toBe('submit');
    expect(body.data.status).toBe('completed');
  });
});
