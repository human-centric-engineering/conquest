/**
 * Unit tests for the streaming data-slot generation route.
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/generate/stream/route.ts
 *
 * The non-streaming sibling (`../generate`) is covered by
 * tests/integration/api/v1/app/questionnaires/data-slots-routes.test.ts; this SSE variant had no
 * test of its own. Every collaborator is mocked at the module boundary and `sseResponse` is
 * captured so the driving generator can be drained and its emitted events asserted — the route's
 * real work (forwarding events, persisting the draft, choosing `persisted`) happens inside that
 * generator, so a test that never drains it asserts nothing.
 *
 * Pinned here:
 *   - the pre-stream gates (rate limit, missing structure, unseeded agent) short-circuit before
 *     any generation work starts
 *   - cohesion is measured and threaded into the generator, and a measurement failure degrades to
 *     `cohesion: null` rather than failing generation (best-effort by design)
 *   - the terminal `done` event reports persistence honestly: true on write, false when the write
 *     throws or there is nothing to write, and no `done` at all after a fatal `error`
 *   - granularity falls back to the default on a missing or invalid body
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ───────────────────────────────────

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

vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  // Shape matches the real `RateLimitResult` so the mock can't feed `undefined` to the route.
  dataSlotsGenerationLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-routes', () => ({
  buildDataSlotStructure: vi.fn(),
  upsertDataSlotDraft: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  ensureVersionSlotsEmbedded: vi.fn(),
  typedQuestionCohesion: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/data-slots/generate-stream', () => ({
  streamDataSlotGeneration: vi.fn(),
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG: 'questionnaire-data-slots',
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

// Using `unknown` args avoids fighting Next.js handler overload union types in test context.
type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/data-slots/generate/stream/route')) as {
    POST: AnyRouteHandler;
  };

import { prisma } from '@/lib/db/client';
import { dataSlotsGenerationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  buildDataSlotStructure,
  upsertDataSlotDraft,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import {
  ensureVersionSlotsEmbedded,
  typedQuestionCohesion,
} from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { streamDataSlotGeneration } from '@/lib/app/questionnaire/data-slots/generate-stream';
import { sseResponse } from '@/lib/api/sse';
import { DEFAULT_DATA_SLOT_GRANULARITY } from '@/lib/app/questionnaire/data-slots';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

const AGENT = {
  id: 'agent-slots-1',
  provider: 'openai',
  model: 'gpt-5.4',
  fallbackProviders: ['anthropic'],
};

const STRUCTURE = {
  goal: 'Understand onboarding friction',
  audience: null,
  questions: [
    { key: 'q1', prompt: 'How easy was onboarding?', type: 'likert', sectionTitle: 'Start' },
    { key: 'q2', prompt: 'What slowed you down?', type: 'free_text', sectionTitle: 'Start' },
  ],
};

const FINAL_SLOTS = [
  {
    name: 'Onboarding ease',
    description: 'How smoothly the user got started.',
    theme: 'Friction',
    questionKeys: ['q1'],
    confidence: 0.9,
  },
];

/** Build the POST request. `body` undefined → a request whose `json()` rejects (no body). */
function makeRequest(body?: unknown): NextRequest {
  const url = `http://localhost/api/v1/app/questionnaires/${QN_ID}/versions/${VID}/data-slots/generate/stream`;
  if (body === undefined) return new NextRequest(url, { method: 'POST' });
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** withAdminAuth is mocked to identity, so POST is the bare (request, session, context) handler. */
async function callStream(req: NextRequest = makeRequest()): Promise<Response> {
  return POST(req, ADMIN_SESSION, { params: Promise.resolve({ id: QN_ID, vid: VID }) });
}

/** Point `streamDataSlotGeneration` at a generator yielding `events` then returning `finalSlots`. */
function mockGeneration(events: unknown[], finalSlots: unknown[] = FINAL_SLOTS): void {
  (streamDataSlotGeneration as Mock).mockImplementation(async function* () {
    for (const ev of events) yield ev;
    return finalSlots;
  });
}

/** Drain the generator captured by sseResponse, collecting everything it emitted. */
async function drain(): Promise<unknown[]> {
  const emitted: unknown[] = [];
  for await (const ev of capturedGen!) emitted.push(ev);
  return emitted;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedGen = undefined;
  (dataSlotsGenerationLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  (buildDataSlotStructure as Mock).mockResolvedValue(STRUCTURE);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  (ensureVersionSlotsEmbedded as Mock).mockResolvedValue(undefined);
  (typedQuestionCohesion as Mock).mockResolvedValue(0.72);
  (upsertDataSlotDraft as Mock).mockResolvedValue(undefined);
  mockGeneration([{ type: 'start', groups: [] }]);
});

// ═════════════════════════════════════════════════════════════════════════════
// POST .../data-slots/generate/stream
// ═════════════════════════════════════════════════════════════════════════════

describe('POST data-slots/generate/stream', () => {
  describe('pre-stream gates', () => {
    it('returns the createRateLimitResponse result and starts no generation when rate limited', async () => {
      (dataSlotsGenerationLimiter.check as Mock).mockReturnValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: 9_999_999_999_999,
      });

      const res = await callStream();

      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(res).toBe(vi.mocked(createRateLimitResponse).mock.results[0]?.value);
      expect(res.status).toBe(429);
      // Keyed on the admin user id, not the client IP.
      expect(dataSlotsGenerationLimiter.check).toHaveBeenCalledWith('admin-1');
      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamDataSlotGeneration).not.toHaveBeenCalled();
      // The rate limit is checked before the (DB + embedding) work it exists to protect.
      expect(buildDataSlotStructure).not.toHaveBeenCalled();
      expect(ensureVersionSlotsEmbedded).not.toHaveBeenCalled();
    });

    it('throws NotFoundError and opens no stream when the version has no question structure', async () => {
      (buildDataSlotStructure as Mock).mockResolvedValue(null);

      await expect(callStream()).rejects.toThrow(/not found or has no questions/i);

      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamDataSlotGeneration).not.toHaveBeenCalled();
      // Bails before the agent lookup.
      expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the generator agent is not seeded', async () => {
      (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

      await expect(callStream()).rejects.toThrow(/not configured/i);

      expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ slug: 'questionnaire-data-slots' }),
        })
      );
      expect(sseResponse).not.toHaveBeenCalled();
      expect(streamDataSlotGeneration).not.toHaveBeenCalled();
    });
  });

  describe('cohesion measurement', () => {
    it('embeds the version, measures cohesion, and threads it into the generator', async () => {
      await callStream();
      await drain();

      expect(ensureVersionSlotsEmbedded).toHaveBeenCalledWith(VID);
      expect(typedQuestionCohesion).toHaveBeenCalledWith(VID);
      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          cohesion: 0.72,
          structure: STRUCTURE,
          versionId: VID,
          agentId: AGENT.id,
          agent: {
            provider: AGENT.provider,
            model: AGENT.model,
            fallbackProviders: AGENT.fallbackProviders,
          },
        })
      );
    });

    it('degrades to cohesion null and still generates when embedding throws', async () => {
      (ensureVersionSlotsEmbedded as Mock).mockRejectedValue(new Error('no embedder configured'));

      const res = await callStream();
      const emitted = await drain();

      // Best-effort by design: a missing embedder must not fail generation.
      expect(res.status).toBe(200);
      expect(typedQuestionCohesion).not.toHaveBeenCalled();
      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ cohesion: null })
      );
      expect(emitted).toContainEqual(expect.objectContaining({ type: 'done' }));
    });

    it('degrades to cohesion null when the measurement query itself throws', async () => {
      (typedQuestionCohesion as Mock).mockRejectedValue(new Error('vector op unavailable'));

      await callStream();
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ cohesion: null })
      );
    });

    it('passes cohesion null through when the measurement returns null (too few typed slots)', async () => {
      (typedQuestionCohesion as Mock).mockResolvedValue(null);

      await callStream();
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ cohesion: null })
      );
    });
  });

  describe('event forwarding and persistence', () => {
    it('forwards every generator event in order and appends a terminal done with the final slots', async () => {
      mockGeneration([
        { type: 'start', groups: [{ index: 0, title: 'Start', questionCount: 2 }] },
        { type: 'group_done', index: 0, title: 'Start', slots: FINAL_SLOTS },
        { type: 'merge_start', rawSlotCount: 1 },
      ]);

      await callStream();
      const emitted = await drain();

      expect(emitted.map((e) => (e as { type: string }).type)).toEqual([
        'start',
        'group_done',
        'merge_start',
        'done',
      ]);
      expect(emitted.at(-1)).toEqual({ type: 'done', slots: FINAL_SLOTS, persisted: true });
      expect(upsertDataSlotDraft).toHaveBeenCalledWith(VID, FINAL_SLOTS);
    });

    it('reports persisted false — without throwing — when the draft write fails mid-stream', async () => {
      (upsertDataSlotDraft as Mock).mockRejectedValue(new Error('db down'));

      await callStream();
      const emitted = await drain();

      // The response was already streamed, so a persist failure is reported, not retro-failed.
      expect(emitted.at(-1)).toEqual({ type: 'done', slots: FINAL_SLOTS, persisted: false });
    });

    it('skips the draft write and reports persisted false when generation yields no slots', async () => {
      mockGeneration([{ type: 'start', groups: [] }], []);

      await callStream();
      const emitted = await drain();

      expect(upsertDataSlotDraft).not.toHaveBeenCalled();
      expect(emitted.at(-1)).toEqual({ type: 'done', slots: [], persisted: false });
    });

    it('stops after a fatal error event — no draft write, no done event', async () => {
      mockGeneration([
        { type: 'start', groups: [] },
        { type: 'error', code: 'generation_failed', message: 'Every section failed' },
      ]);

      await callStream();
      const emitted = await drain();

      expect(emitted.map((e) => (e as { type: string }).type)).toEqual(['start', 'error']);
      expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'done' }));
      expect(upsertDataSlotDraft).not.toHaveBeenCalled();
    });
  });

  describe('granularity', () => {
    it('forwards a valid granularity from the body', async () => {
      await callStream(makeRequest({ granularity: 'granular' }));
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: 'granular' })
      );
    });

    it('falls back to the default when the body has no granularity', async () => {
      await callStream(makeRequest({}));
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: DEFAULT_DATA_SLOT_GRANULARITY })
      );
    });

    it('falls back to the default when granularity is not a known level', async () => {
      await callStream(makeRequest({ granularity: 'ultra-fine' }));
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: DEFAULT_DATA_SLOT_GRANULARITY })
      );
    });

    it('falls back to the default when there is no JSON body at all', async () => {
      await callStream(makeRequest());
      await drain();

      expect(streamDataSlotGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: DEFAULT_DATA_SLOT_GRANULARITY })
      );
    });
  });
});
