/**
 * Integration test: questionnaire pre-launch cost-estimate route (F3.3).
 *
 * Exercises the GET handler with the DB seam (`prisma`), the model registry, the
 * settings resolver, and the token estimator mocked: gate order (404 flag-off
 * before auth), 401/403, scope-404, `respondents` validation, the happy path
 * (asserting the registry + token estimator were consulted and the response
 * shape), and the pricing-unknown branch. The estimator math itself is
 * unit-tested separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/model-registry', () => ({ getModel: vi.fn() }));
vi.mock('@/lib/orchestration/chat/token-estimator', () => ({ estimateTokens: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionSlot: { findMany: vi.fn() },
  appQuestionnaireConfig: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/cost-estimate/route';

import { auth } from '@/lib/auth/config';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(
  url = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/cost-estimate'
) {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

const pricedModel = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet',
  provider: 'anthropic',
  tier: 'mid',
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  maxContext: 200_000,
  supportsTools: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  // Default: a scoped version exists with 3 questions and a saved config.
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  prismaMock.appQuestionSlot.findMany.mockResolvedValue([
    { prompt: 'Q1' },
    { prompt: 'Q2' },
    { prompt: 'Q3' },
  ]);
  prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
    maxQuestionsPerSession: null,
    minQuestionsAnswered: 0,
  });
  (getDefaultModelForTaskOrNull as unknown as Mock).mockResolvedValue('claude-sonnet-4-6');
  (getModel as unknown as Mock).mockReturnValue(pricedModel);
  (estimateTokens as unknown as Mock).mockReturnValue(40);
});

describe('gate order + auth', () => {
  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await GET(req(), ctx(PARAMS))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    expect((await GET(req(), ctx(PARAMS))).status).toBe(403);
  });

  it('404s when the version does not resolve under the questionnaire (scope-404)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(404);
    // Scoping happens before any estimation work.
    expect(prismaMock.appQuestionSlot.findMany).not.toHaveBeenCalled();
  });
});

describe('query validation', () => {
  it('rejects a non-integer respondents value', async () => {
    const res = await GET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/cost-estimate?respondents=abc'
      ),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
  });

  it('rejects respondents below 1', async () => {
    const res = await GET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/cost-estimate?respondents=0'
      ),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
  });

  it('defaults respondents to 1 when omitted', async () => {
    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.respondents).toBe(1);
  });
});

describe('happy path', () => {
  it('consults the registry + token estimator and returns a priced estimate', async () => {
    const res = await GET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/cost-estimate?respondents=20'
      ),
      ctx(PARAMS)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const e = body.data;
    expect(e.basedOn).toBe('heuristic');
    expect(e.pricingKnown).toBe(true);
    expect(e.model).toBe('claude-sonnet-4-6');
    expect(e.respondents).toBe(20);
    expect(e.assumptions.questionCount).toBe(3);
    expect(e.perSession.midUsd).toBeGreaterThan(0);
    // midUsd must be the registry rates applied to the computed token volume — derive
    // it from the response's own assumptions + the mocked rates (3 in / 15 out per M)
    // so the check pins the pricing wiring without hardcoding the heuristic constants.
    const expectedMid =
      (e.assumptions.inputTokensPerSession / 1_000_000) * 3 +
      (e.assumptions.outputTokensPerSession / 1_000_000) * 15;
    expect(e.perSession.midUsd).toBeCloseTo(expectedMid, 10);
    // perQuestionnaire = perSession × respondents.
    expect(e.perQuestionnaire.midUsd).toBeCloseTo(e.perSession.midUsd * 20, 6);

    expect(getModel).toHaveBeenCalledWith('claude-sonnet-4-6');
    // One token estimate per question slot, each with the slot prompt + resolved model.
    expect(estimateTokens).toHaveBeenCalledTimes(3);
    expect(estimateTokens).toHaveBeenCalledWith('Q1', 'claude-sonnet-4-6');
    expect(estimateTokens).toHaveBeenCalledWith('Q2', 'claude-sonnet-4-6');
    expect(estimateTokens).toHaveBeenCalledWith('Q3', 'claude-sonnet-4-6');
  });

  it('falls back to the default config when the version has no saved config row', async () => {
    // Lazy materialisation: no config row yet → the route resolves DEFAULT_QUESTIONNAIRE_CONFIG
    // (no cap, zero floor), so all three questions are asked. Exercises route L100-103.
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.assumptions.effectiveQuestionsPerSession).toBe(3);
    expect(body.data.pricingKnown).toBe(true);
  });

  it('falls back to a default model when no chat default is configured', async () => {
    (getDefaultModelForTaskOrNull as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx(PARAMS));
    const body = await res.json();
    expect(body.data.model).toBe('claude-sonnet-4-6');
    expect(getModel).toHaveBeenCalledWith('claude-sonnet-4-6');
  });
});

describe('pricing-unknown branch', () => {
  it('withholds USD when the resolved model has no registry price', async () => {
    (getModel as unknown as Mock).mockReturnValue(undefined);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.pricingKnown).toBe(false);
    expect(body.data.perSession.midUsd).toBe(0);
    expect(body.data.notes).toMatch(/no registry price/i);
  });

  it('treats a registry $0 rate as pricing-unknown, not free', async () => {
    (getModel as unknown as Mock).mockReturnValue({
      ...pricedModel,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.pricingKnown).toBe(false);
  });
});
