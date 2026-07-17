/**
 * Integration tests for GET /api/v1/app/questionnaires/prompts (Prompt Library).
 *
 * Exercises the real guards (`withQuestionnairesEnabled` + `withAdminAuth`) with a
 * mocked auth + feature flag, and the DB-merge seam: the catalog is built in-process
 * and each agent's seeded `AiAgent` row is folded in. Asserts the success envelope,
 * the `resolvesAtRuntime` binding derivation, and the `seeded: false` fallback for an
 * agent with no row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/app/questionnaires/prompts/route';
import {
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/prompts',
    headers: new Headers(),
  } as unknown as NextRequest;
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

interface AgentView {
  slug: string;
  seeded: boolean;
  binding: { resolvesAtRuntime: boolean; provider: string; model: string } | null;
  storedInstructions: string | null;
  instructionsAreLoadBearing: boolean;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  // One seeded row with an empty (runtime-resolved) binding; the rest are absent.
  prismaMock.aiAgent.findMany.mockResolvedValue([
    {
      slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
      provider: '',
      model: '',
      temperature: 0.2,
      maxTokens: 4096,
      monthlyBudgetUsd: 50,
      visibility: 'internal',
      isActive: true,
      systemInstructions: 'You are the answer extractor.',
    },
  ]);
});

describe('GET /api/v1/app/questionnaires/prompts', () => {
  it('rejects a non-admin user', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns the catalog merged with seeded bindings', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { agents: AgentView[] } };
    expect(body.success).toBe(true);

    const { agents } = body.data;
    expect(agents.length).toBeGreaterThan(0);
    // Only the streamChat-dispatched selector is load-bearing; every other agent
    // assembles its prompt in code.
    expect(
      agents
        .filter((a) => a.slug !== QUESTIONNAIRE_SELECTOR_AGENT_SLUG)
        .every((a) => a.instructionsAreLoadBearing === false)
    ).toBe(true);
    expect(
      agents.find((a) => a.slug === QUESTIONNAIRE_SELECTOR_AGENT_SLUG)?.instructionsAreLoadBearing
    ).toBe(true);

    const extractor = agents.find((a) => a.slug === QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG);
    expect(extractor?.seeded).toBe(true);
    expect(extractor?.binding?.resolvesAtRuntime).toBe(true);
    expect(extractor?.storedInstructions).toBe('You are the answer extractor.');
  });

  it('falls back to seeded:false for agents with no DB row', async () => {
    prismaMock.aiAgent.findMany.mockResolvedValue([]);
    const res = await GET(req());
    const body = (await res.json()) as { success: boolean; data: { agents: AgentView[] } };
    expect(body.data.agents.every((a) => a.seeded === false)).toBe(true);
    expect(body.data.agents.every((a) => a.binding === null)).toBe(true);
  });
});
