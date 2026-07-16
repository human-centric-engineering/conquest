/**
 * Unit tests for the Agent Settings API routes.
 *
 * Files under test:
 *   app/api/v1/app/questionnaires/agent-settings/route.ts          (GET evaluation)
 *   app/api/v1/app/questionnaires/agent-settings/explain/route.ts  (POST explain)
 *
 * Collaborators mocked at the module boundary; the auth + flag guards are
 * pass-throughs that inject a session. Asserts what the routes DO — status codes,
 * envelope shape, error mapping, rate-limit short-circuit — not mock echoes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth:
    (handler: (req: NextRequest, session: { user: { id: string } }) => unknown) =>
    (req: NextRequest) =>
      handler(req, { user: { id: 'admin-1' } }),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  settingsAdvisorLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));
vi.mock('@/lib/app/questionnaire/agent-advisory/evaluate', () => ({
  evaluateAgentSettings: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/agent-advisory/explain', () => ({
  explainAgentSettings: vi.fn(),
}));

import { evaluateAgentSettings } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import { explainAgentSettings } from '@/lib/app/questionnaire/agent-advisory/explain';
import { settingsAdvisorLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { GET as rawGet } from '@/app/api/v1/app/questionnaires/agent-settings/route';
import { POST as rawPost } from '@/app/api/v1/app/questionnaires/agent-settings/explain/route';

// The mocked auth/flag guards are pass-throughs that inject the session, so the
// handlers are single-arg at runtime; cast away the real 2-arg wrapper signature.
const GET = rawGet;
const POST = rawPost;

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (settingsAdvisorLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  // Default stubs so no test inherits a prior test's implementation
  // (clearAllMocks resets call history, not implementations).
  (evaluateAgentSettings as Mock).mockResolvedValue({
    generatedAt: 'now',
    taskTiers: [],
    infraDefaults: [],
    agents: [],
  });
  (explainAgentSettings as Mock).mockResolvedValue({
    ok: true,
    value: { narrative: 'ok', suggestion: null },
  });
});

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/app/questionnaires/agent-settings/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /agent-settings', () => {
  it('returns the evaluation envelope', async () => {
    // Two agents — one optimal, one not — so the handler's `isOptimal` filter
    // predicate actually runs when it logs the optimal count.
    const evaluation = {
      generatedAt: 'now',
      taskTiers: [],
      infraDefaults: [],
      agents: [
        { slug: 'a', isOptimal: true },
        { slug: 'b', isOptimal: false },
      ],
    };
    (evaluateAgentSettings as Mock).mockResolvedValue(evaluation);

    const res = await GET(
      new NextRequest('http://localhost/api/v1/app/questionnaires/agent-settings')
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(evaluation);
  });
});

describe('POST /agent-settings/explain', () => {
  it('returns the explanation on success', async () => {
    const explanation = { narrative: 'fine', suggestion: null };
    (explainAgentSettings as Mock).mockResolvedValue({ ok: true, value: explanation });

    const res = await POST(postReq({ slug: 'app-questionnaire-selector' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual(explanation);
    expect(explainAgentSettings).toHaveBeenCalledWith('app-questionnaire-selector');
  });

  it('maps agent_not_found to 404', async () => {
    (explainAgentSettings as Mock).mockResolvedValue({
      ok: false,
      code: 'agent_not_found',
      message: 'nope',
    });
    const res = await POST(postReq({ slug: 'ghost' }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('AGENT_NOT_FOUND');
  });

  it('maps provider failures to 503', async () => {
    (explainAgentSettings as Mock).mockResolvedValue({
      ok: false,
      code: 'provider_unavailable',
      message: 'down',
    });
    const res = await POST(postReq({ slug: 'app-questionnaire-selector' }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('rejects a missing slug with 400 and never calls the advisor', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(explainAgentSettings).not.toHaveBeenCalled();
  });

  it('short-circuits with 429 when rate limited', async () => {
    (settingsAdvisorLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 123,
    });
    const res = await POST(postReq({ slug: 'app-questionnaire-selector' }));
    expect(res.status).toBe(429);
    expect(explainAgentSettings).not.toHaveBeenCalled();
  });
});
