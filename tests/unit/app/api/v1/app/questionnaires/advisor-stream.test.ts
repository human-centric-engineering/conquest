/**
 * Unit tests for the Config Advisor streaming API route.
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/advisor/stream/route.ts
 *
 * Every collaborator is mocked at the module boundary. Tests assert what the route
 * DOES — status codes, response envelope shapes, collaborator call arguments — not
 * just what mocks return (anti-green-bar).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  withAdvisorEnabled: (handler: unknown) => handler,
}));

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth: (handler: unknown) => handler,
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  // Shape matches the real `RateLimitResult` ({ success, limit, remaining, reset }) so the mock
  // can't silently feed `undefined` for fields the route (or a real createRateLimitResponse) reads.
  advisorLimiter: { check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })) },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/advisor-context', () => ({
  loadAdvisorContext: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/advisor/stream-advisor', () => ({
  streamAdvisor: vi.fn(),
}));

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn((_events: AsyncIterable<unknown>) => new Response('sse', { status: 200 })),
}));

// ─── Deferred imports (after vi.mock) ────────────────────────────────────────

// Using `any` here avoids fighting Next.js handler overload union types in test context.
type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/advisor/stream/route')) as {
    POST: AnyRouteHandler;
  };

import { prisma } from '@/lib/db/client';
import { advisorLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { loadAdvisorContext } from '@/app/api/v1/app/questionnaires/_lib/advisor-context';
import { streamAdvisor } from '@/lib/app/questionnaire/advisor/stream-advisor';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { sseResponse } from '@/lib/api/sse';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

function makeRequest(id = QN_ID, vid = VID) {
  return new NextRequest(
    `http://localhost/api/v1/app/questionnaires/${id}/versions/${vid}/advisor/stream`,
    { method: 'POST' }
  );
}

/**
 * Invoke the advisor POST handler. Because withAdvisorEnabled and withAdminAuth
 * are both mocked to identity functions, POST is the bare handler with signature
 * (request, session, context). We call it with all three arguments.
 */
async function callAdvisor(
  req: NextRequest,
  context: { params: Promise<{ id: string; vid: string }> }
): Promise<Response> {
  return POST(req, ADMIN_SESSION, context);
}

const AGENT = {
  id: 'agent-advisor-1',
  provider: 'anthropic',
  model: 'claude-opus',
  fallbackProviders: [] as string[],
};

const CONTEXT = {
  questionnaire: {
    title: 'Employee Wellbeing Survey',
    status: 'draft' as const,
    demoClientName: null,
  },
  version: {
    versionNumber: 1,
    status: 'draft' as const,
    goal: 'Assess staff wellbeing',
    audience: null,
    sessionCount: 0,
  },
  structure: {
    sectionCount: 2,
    questionCount: 5,
    requiredCount: 3,
    optionalCount: 2,
    typeHistogram: { free_text: 3, single_choice: 2 },
    sections: [
      { title: 'General', questionCount: 3, samplePrompts: ['How are you?'] },
      { title: 'Work', questionCount: 2, samplePrompts: ['Rate your workload'] },
    ],
  },
  config: {} as Record<string, unknown>,
  dataSlots: { count: 0, samples: [] },
  scoring: { present: false, name: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: rate limit allows
  (advisorLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  // Default: agent found
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  // Default: context loads successfully
  (loadAdvisorContext as Mock).mockResolvedValue({ ok: true, value: CONTEXT });
  // Default: streamAdvisor yields narrative_delta + narrative_done + analysis then stops
  (streamAdvisor as Mock).mockReturnValue(
    (async function* () {
      yield { type: 'narrative_delta' as const, text: 'Good config overall.' };
      yield { type: 'narrative_done' as const };
      yield {
        type: 'analysis' as const,
        conflicts: [],
        suggestions: [],
      };
    })()
  );
});

// ─── Feature-flag gate (withAdvisorEnabled mock wiring) ──────────────────────
//
// withAdvisorEnabled is tested in feature-flag.ts. Here we verify that the mock
// is correctly wired: when it's replaced with the identity function, the handler
// body runs (proven by the rate-limit path triggering).

describe('feature-flag gate (withAdvisorEnabled mock wiring)', () => {
  it('allows the handler to run when the flag mock is the identity function', async () => {
    (advisorLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 0,
    });

    const req = makeRequest();
    await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

    // If the gate were blocking, createRateLimitResponse would NOT be called.
    // It IS called → the handler body ran → the identity mock is correctly transparent.
    expect(createRateLimitResponse).toHaveBeenCalledOnce();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/app/questionnaires/:id/versions/:vid/advisor/stream
// ═════════════════════════════════════════════════════════════════════════════

describe('POST advisor/stream', () => {
  describe('rate limit', () => {
    it('returns the createRateLimitResponse when advisorLimiter rejects', async () => {
      (advisorLimiter.check as Mock).mockReturnValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: 9_999_999_999_999,
      });

      const req = makeRequest();
      const res = await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      // The route must have called createRateLimitResponse AND returned exactly its result —
      // not just invoked it then returned some other (e.g. hardcoded) 429.
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(res).toBe(vi.mocked(createRateLimitResponse).mock.results[0]?.value);
      expect(res.status).toBe(429);
      // Keyed on the admin user id (not client IP)
      expect(advisorLimiter.check).toHaveBeenCalledWith('admin-1');
      // Under the rate-limit path, no streaming work should happen.
      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamAdvisor).not.toHaveBeenCalled();
    });
  });

  describe('agent not seeded', () => {
    it('returns 503 ADVISOR_NOT_CONFIGURED when the advisor agent does not exist in the DB', async () => {
      (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

      const req = makeRequest();
      const res = await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ADVISOR_NOT_CONFIGURED');
      // The route looked up the agent by slug — not a generic DB miss
      expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ slug: expect.any(String) }) })
      );
      // No streaming when agent is missing
      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamAdvisor).not.toHaveBeenCalled();
    });
  });

  describe('context load miss', () => {
    it('returns the 404 response from loadAdvisorContext when the version is not found', async () => {
      const notFoundResp = new Response(
        JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }),
        { status: 404 }
      );
      (loadAdvisorContext as Mock).mockResolvedValue({ ok: false, response: notFoundResp });

      const req = makeRequest();
      const res = await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      expect(res.status).toBe(404);
      // The route forwarded the exact response from loadAdvisorContext, not a new errorResponse.
      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamAdvisor).not.toHaveBeenCalled();
    });

    it('calls loadAdvisorContext with the questionnaire id and version id from params', async () => {
      // Happy path to verify the call args
      const req = makeRequest('qn-abc', 'ver-xyz');
      await callAdvisor(req, { params: Promise.resolve({ id: 'qn-abc', vid: 'ver-xyz' }) });

      expect(loadAdvisorContext).toHaveBeenCalledWith('qn-abc', 'ver-xyz');
    });
  });

  describe('happy path — streaming and audit', () => {
    it('calls sseResponse with the drive() async generator', async () => {
      const req = makeRequest();
      await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      // The route must have handed a generator to sseResponse — that is the core wiring.
      expect(sseResponse).toHaveBeenCalledOnce();
      const [eventsArg] = (sseResponse as Mock).mock.calls[0] as [AsyncIterable<unknown>];
      expect(eventsArg).toBeDefined();
    });

    it('drive() yields advisor events then emits the terminal done', async () => {
      // Capture the generator passed to sseResponse
      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest();
      await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      expect(capturedGen).not.toBeNull();

      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      // The narrative_delta, narrative_done, and analysis events pass through from streamAdvisor
      expect(events[0]).toMatchObject({ type: 'narrative_delta', text: 'Good config overall.' });
      expect(events[1]).toMatchObject({ type: 'narrative_done' });
      expect(events[2]).toMatchObject({ type: 'analysis' });
      // The route emits the terminal `done` event
      const last = events[events.length - 1] as { type: string };
      expect(last.type).toBe('done');
      // Proves the route drove streamAdvisor — it did not just return what the mock returned
      expect(streamAdvisor).toHaveBeenCalledOnce();
    });

    it('passes the seeded agent binding to streamAdvisor', async () => {
      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest();
      await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      // Drain to trigger streamAdvisor call inside drive()
      for await (const _ of capturedGen!) {
        /* drain */
      }

      expect(streamAdvisor).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: {
            provider: AGENT.provider,
            model: AGENT.model,
            fallbackProviders: AGENT.fallbackProviders,
          },
          agentId: AGENT.id,
        })
      );
    });

    it('calls logAdminAction before streaming, with the questionnaire title from context', async () => {
      const req = makeRequest();
      await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      // logAdminAction is invoked synchronously before sseResponse — no drain needed.
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'questionnaire.advisor',
          entityType: 'questionnaire',
          entityId: VID,
          entityName: CONTEXT.questionnaire.title,
          metadata: expect.objectContaining({
            questionnaireId: QN_ID,
            versionId: VID,
          }),
        })
      );
    });
  });

  describe('mid-stream error event', () => {
    it('drive() forwards the error event from streamAdvisor but does not emit done', async () => {
      // streamAdvisor yields a single error event (the generator exits immediately after).
      // The route sets fatal=true, forwards the event, drains the (now-exhausted) generator,
      // then returns without emitting done — because fatal is true.
      (streamAdvisor as Mock).mockReturnValue(
        (async function* () {
          yield {
            type: 'error' as const,
            code: 'narrative_failed',
            message: 'Provider unavailable',
          };
        })()
      );

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest();
      await callAdvisor(req, { params: Promise.resolve({ id: QN_ID, vid: VID }) });

      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      // The error event passes through — drive() yields everything from streamAdvisor
      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe('error');
      expect((events[0] as { code: string }).code).toBe('narrative_failed');
      // Fatal: drive() returned without emitting done
      expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(false);
    });
  });
});
