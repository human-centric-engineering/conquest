/**
 * Integration tests: plan preview route — Adaptive Scope (F17.14).
 *
 *   POST /api/v1/app/questionnaires/:id/versions/:vid/topics/preview
 *
 * Three things this route must never get wrong, in rough order of consequence:
 *
 * 1. **It writes nothing.** It runs the real planner against a synthetic opening, so the one way it
 *    could do damage is by leaving a plan or a session behind. Asserted directly.
 * 2. **The planner sees what the author typed.** The whole value of a dry-run is that it is the
 *    same decision the interview would take — same topics, same settings, same budget. If the route
 *    quietly drops the answers or the fills, the preview still renders and is simply wrong.
 * 3. **The gates hold.** Non-admin → 403, unauthenticated → 401, cross-questionnaire vid → 404,
 *    and the per-admin sub-cap on a button that spends a model call per press.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
    appQuestionnaireSession: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('@/lib/app/questionnaire/scope/planner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/app/questionnaire/scope/planner')>();
  return { ...real, planScope: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-routes')>();
  return { ...real, loadAdaptiveScopeSettings: vi.fn(), loadTopics: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/preview/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { planScope } from '@/lib/app/questionnaire/scope/planner';
import {
  loadAdaptiveScopeSettings,
  loadTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
  type InterviewPlan,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const PARAMS = { id: 'qn-1', vid: 'ver-1' };

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function jsonReq(body: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function conditionalTopic(): Topic {
  return {
    id: 'topic-1',
    key: 'wellbeing',
    label: 'Wellbeing',
    description: null,
    phase: 'conditional',
    criteria: 'Respondent mentions stress',
    depth: 'full',
    members: { questionKeys: ['q1'], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
  };
}

function samplePlan(): InterviewPlan {
  return {
    v: 1,
    topics: [{ key: 'wellbeing', depth: 'full', source: 'llm', rationale: 'they named stress' }],
    excluded: [],
    checkTopicKey: null,
    confidence: 0.8,
    source: 'llm',
    respondentMessage: 'I want to go deeper on wellbeing.',
    decidedAtTurn: 0,
    decidedAt: '2026-08-14T00:00:00.000Z',
  };
}

function plannerResult(overrides: Record<string, unknown> = {}) {
  return {
    plan: samplePlan(),
    costUsd: 0.004,
    provider: 'openai',
    model: 'gpt-5.4',
    promptSnapshot: 'prompt',
    // The real snapshot is the planner's own Zod-validated response, so the fixture carries every
    // field that schema requires — a partial one would pass a looser reader and lie about it.
    outputSnapshot: {
      selected: [{ topicKey: 'wellbeing', rationale: 'they named stress' }],
      confidence: 0.8,
      respondentMessage: 'I want to go deeper on wellbeing.',
    },
    ...overrides,
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();

  setAuth(mockAdminUser());
  (loadScopedVersion as Mock).mockResolvedValue({
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    status: 'draft',
  });
  (loadAdaptiveScopeSettings as Mock).mockResolvedValue(DEFAULT_ADAPTIVE_SCOPE_SETTINGS);
  (loadTopics as Mock).mockResolvedValue([conditionalTopic()]);
  (prisma.appQuestionSlot.findMany as Mock).mockResolvedValue([
    { key: 'open_a', prompt: 'What brought you here?' },
  ]);
  (prisma.appDataSlot.findMany as Mock).mockResolvedValue([]);
  (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({ goal: 'Diagnose it' });
  (planScope as Mock).mockResolvedValue(plannerResult());
});

describe('POST topics/preview — gates', () => {
  it('rejects a non-admin with 403', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    expect(res.status).toBe(403);
    expect(planScope).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    expect(res.status).toBe(401);
    expect(planScope).not.toHaveBeenCalled();
  });

  it('404s when the version does not belong to the questionnaire', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(planScope).not.toHaveBeenCalled();
  });

  it('422s rather than planning when the version has no topics', async () => {
    (loadTopics as Mock).mockResolvedValue([]);
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    expect(res.status).toBe(422);
    expect(planScope).not.toHaveBeenCalled();
  });
});

describe('POST topics/preview — it writes nothing', () => {
  it('creates no session and updates no plan', async () => {
    const res = await POST(
      jsonReq({ answers: [{ key: 'open_a', text: 'Deals keep slipping' }] }),
      ctx(PARAMS)
    );

    expect(res.status).toBe(200);
    // The single most important property of this route: it is a dry-run. A preview that left a
    // plan behind would change what a real respondent is asked.
    expect(prisma.appQuestionnaireSession.create).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });

  it('passes a non-session reference to the planner', async () => {
    await POST(jsonReq({ answers: [] }), ctx(PARAMS));

    const params = (planScope as Mock).mock.calls[0]?.[0] as { sessionId: string };
    // Shaped so a cost row or a log line can never be mistaken for a real interview.
    expect(params.sessionId).toBe('preview:ver-1');
  });
});

describe('POST topics/preview — what the planner is given', () => {
  it('pairs each typed answer with the question it answered', async () => {
    await POST(jsonReq({ answers: [{ key: 'open_a', text: 'Deals keep slipping' }] }), ctx(PARAMS));

    const params = (planScope as Mock).mock.calls[0]?.[0] as {
      answers: { key: string; prompt: string; paraphrase: string }[];
    };
    // An answer without its question is not evidence — the planner's prompt says so, and the route
    // is what supplies the pairing.
    expect(params.answers).toEqual([
      {
        key: 'open_a',
        prompt: 'What brought you here?',
        value: null,
        paraphrase: 'Deals keep slipping',
      },
    ]);
  });

  it('drops an answer whose question no longer exists', async () => {
    await POST(
      jsonReq({
        answers: [
          { key: 'open_a', text: 'Deals keep slipping' },
          { key: 'deleted_q', text: 'orphaned' },
        ],
      }),
      ctx(PARAMS)
    );

    const params = (planScope as Mock).mock.calls[0]?.[0] as { answers: { key: string }[] };
    expect(params.answers.map((a) => a.key)).toEqual(['open_a']);
  });

  it('passes the fills the author set, and only those', async () => {
    await POST(
      jsonReq({
        answers: [],
        fills: [{ key: 'outcome', paraphrase: 'wants shorter cycles' }],
      }),
      ctx(PARAMS)
    );

    const params = (planScope as Mock).mock.calls[0]?.[0] as { fills: { key: string }[] };
    // An omitted slot stays omitted: absence is what a `not_exists` veto matches on, so the route
    // must not helpfully materialise an empty fill for every slot in the version.
    expect(params.fills).toEqual([
      { key: 'outcome', value: null, paraphrase: 'wants shorter cycles' },
    ]);
  });
});

describe('POST topics/preview — it prices the instrument like the interview does', () => {
  it('hands the planner the same budget the live trigger would', async () => {
    (loadAdaptiveScopeSettings as Mock).mockResolvedValue({
      ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
      sessionBudgetSeconds: 600,
    });
    (loadTopics as Mock).mockResolvedValue([
      {
        ...conditionalTopic(),
        members: { questionKeys: ['q1'], dataSlotKeys: ['outcome'] },
      },
    ]);
    (prisma.appQuestionSlot.findMany as Mock).mockResolvedValue([
      {
        key: 'open_a',
        prompt: 'What brought you here?',
        type: 'free_text',
        typeConfig: null,
        weight: 0.5,
      },
      { key: 'q1', prompt: 'Rate it', type: 'likert', typeConfig: null, weight: 0.5 },
    ]);
    (prisma.appDataSlot.findMany as Mock).mockResolvedValue([{ key: 'outcome', weight: 0.5 }]);

    await POST(jsonReq({ answers: [] }), ctx(PARAMS));

    const params = (planScope as Mock).mock.calls[0]?.[0] as {
      budget?: { budgetSeconds: number; costs: Map<string, { full: number }> };
    };
    // The whole point of the shared `loadPlanBudget` seam: a preview that priced the instrument
    // differently from the interview would seat topics the real plan drops, and would do it
    // quietly. `wellbeing` holds one likert (8s under the default anchors) and one data slot,
    // priced as an open question at `DEFAULT_SECONDS_PER_DATA_SLOT` (40s) — a topic's slots cost a
    // respondent time too, and pricing only its questions would understate every topic that has any.
    expect(params.budget?.budgetSeconds).toBe(600);
    expect(params.budget?.costs.get('wellbeing')?.full).toBe(48);
  });

  it('passes no budget when the version sets none — the default', async () => {
    await POST(jsonReq({ answers: [] }), ctx(PARAMS));

    const params = (planScope as Mock).mock.calls[0]?.[0] as { budget?: unknown };
    // Same as a real session: no budget means no fit stage, and a plan identical to the one the
    // same inputs produced before budgets existed.
    expect(params.budget).toBeUndefined();
  });
});

describe('POST topics/preview — the decision trace', () => {
  it('returns the model proposal alongside the plan', async () => {
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    const body = (await res.json()) as {
      data: { proposedKeys: string[]; skippedModelReason: string | null; costUsd: number };
    };

    // The one thing the plan itself cannot carry: what the agent wanted before the guardrails ran.
    expect(body.data.proposedKeys).toEqual(['wellbeing']);
    expect(body.data.skippedModelReason).toBeNull();
    expect(body.data.costUsd).toBe(0.004);
  });

  it('stays silent on the ordinary path, where the per-topic sources say it all', async () => {
    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    const body = (await res.json()) as { data: { skippedModelReason: string | null } };
    expect(body.data.skippedModelReason).toBeNull();
  });

  it('says there was nothing to decide when no call was made and nothing failed', async () => {
    (planScope as Mock).mockResolvedValue(
      plannerResult({
        provider: null,
        model: null,
        outputSnapshot: null,
        costUsd: 0,
        // `planScope` records confidence 1 on the nothing-to-decide path.
        plan: { ...samplePlan(), source: 'llm', confidence: 1 },
      })
    );

    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    const body = (await res.json()) as { data: { skippedModelReason: string | null } };

    expect(body.data.skippedModelReason).toMatch(/nothing for the agent to decide/i);
    // Telling an author the agent is unreachable when it is healthy sends them debugging a
    // non-problem — the failure this branch exists to avoid.
    expect(body.data.skippedModelReason).not.toMatch(/could not be reached/i);
  });

  it('says the agent could not be reached only when the call actually failed', async () => {
    (planScope as Mock).mockResolvedValue(
      plannerResult({
        provider: null,
        model: null,
        outputSnapshot: null,
        costUsd: 0,
        // Confidence 0 is what `planScope` records when `askPlanner` returned nothing.
        plan: { ...samplePlan(), source: 'fallback', confidence: 0 },
      })
    );

    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    const body = (await res.json()) as { data: { skippedModelReason: string | null } };

    expect(body.data.skippedModelReason).toMatch(/could not be reached/i);
  });

  it('names the confidence floor when the agent answered and was overruled', async () => {
    (loadAdaptiveScopeSettings as Mock).mockResolvedValue({
      ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS,
      minConfidence: 0.7,
    });
    (planScope as Mock).mockResolvedValue(
      plannerResult({
        // A real call happened — so any check on "was a model called" misses this entirely.
        plan: { ...samplePlan(), source: 'fallback', confidence: 0.4 },
      })
    );

    const res = await POST(jsonReq({ answers: [] }), ctx(PARAMS));
    const body = (await res.json()) as { data: { skippedModelReason: string | null } };

    // The most confusing state to land in unexplained: the model's own picks sit in the excluded
    // list rationalised as though nothing pointed at them.
    expect(body.data.skippedModelReason).toMatch(/40%/);
    expect(body.data.skippedModelReason).toMatch(/70%/);
    expect(body.data.skippedModelReason).toMatch(/fallback/i);
  });
});
