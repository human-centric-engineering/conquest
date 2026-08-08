/**
 * Unit tests for the streaming glossary-analysis route (definitions / glossary, P16).
 *
 * File under test:
 *   app/api/v1/app/questionnaires/[id]/versions/[vid]/glossary/analyse/stream/route.ts
 *
 * Every collaborator is mocked at the module boundary and `sseResponse` is captured so the driving
 * generator can be drained and its emitted events asserted — the route's real work (dispatching,
 * re-validating, persisting, recording provenance) happens inside that generator, so a test that
 * never drains it asserts nothing.
 *
 * Pinned here:
 *   - the pre-stream gates (rate limit, no questions, unseeded agent) short-circuit before any
 *     paid work starts;
 *   - **the run never forks** — a proposal is inert, which is the rule that lets this endpoint be
 *     a plain write against a launched version;
 *   - a dispatch failure and a malformed payload both surface as a terminal `error` event, not a
 *     5xx (the response is already streaming) and never persist;
 *   - the terminal `done` reports the counts the admin surface needs to tell "found nothing" from
 *     "found nothing NEW";
 *   - provenance is recorded on both the success and failure paths.
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

vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  glossaryAnalysisLimiter: {
    check: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/glossary-routes', () => ({
  buildGlossaryAnalysisInput: vi.fn(),
  persistProposedTerms: vi.fn(),
  loadGlossaryTerms: vi.fn(),
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
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/glossary/analyse/stream/route')) as {
    POST: AnyRouteHandler;
  };

import { prisma } from '@/lib/db/client';
import { glossaryAnalysisLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  buildGlossaryAnalysisInput,
  loadGlossaryTerms,
  persistProposedTerms,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };
const QN_ID = 'qn-1';
const VID = 'ver-1';

/** The version's full curated set as the route reads it back for the terminal event. */
const CURATED_SET = [
  {
    id: 'term-1',
    term: 'higher self',
    normalizedTerm: 'higher self',
    aliases: [],
    status: 'proposed',
    source: 'ai_proposed',
    rationale: 'Contested across traditions.',
    contextQuote: null,
    ordinal: 0,
    definitions: [],
  },
];

const AGENT = {
  id: 'agent-glossary-1',
  provider: 'openai',
  model: 'gpt-5.4',
  fallbackProviders: ['anthropic'],
};

const INPUT = {
  goal: 'Assess spiritual development',
  audience: null,
  questions: [
    { key: 'q1', prompt: 'How connected do you feel to your higher self?', sectionTitle: 'Inner' },
  ],
  dataSlotNames: [],
  existingTerms: ['shadow'],
};

const ANALYSIS = {
  terms: [
    {
      term: 'higher self',
      aliases: ['higher-self'],
      rationale: 'Contested across traditions.',
      definitions: [{ text: 'The observing, values-led part of you.' }],
    },
  ],
};

function makeRequest(): NextRequest {
  return {
    url: `http://localhost:3000/api/v1/app/questionnaires/${QN_ID}/versions/${VID}/glossary/analyse/stream`,
    headers: new Headers(),
    signal: new AbortController().signal,
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
  (glossaryAnalysisLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: 0,
  });
  (buildGlossaryAnalysisInput as Mock).mockResolvedValue(INPUT);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: { result: ANALYSIS },
  });
  (persistProposedTerms as Mock).mockResolvedValue({
    proposedCount: 1,
    skippedExistingCount: 0,
    acceptedCount: 2,
  });
  (loadGlossaryTerms as Mock).mockResolvedValue(CURATED_SET);
});

// ─── Pre-stream gates ─────────────────────────────────────────────────────────

describe('POST …/glossary/analyse/stream — pre-stream gates', () => {
  it('returns 429 and does no work when the per-admin cap is hit', async () => {
    (glossaryAnalysisLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: 1,
    });

    const res = await invoke();
    expect(res.status).toBe(429);
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(buildGlossaryAnalysisInput).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws NotFound when the version is missing or has no questions', async () => {
    (buildGlossaryAnalysisInput as Mock).mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow(/not found or has no questions/i);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws NotFound when the analyst agent has not been seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow(/not configured/i);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── The run ──────────────────────────────────────────────────────────────────

describe('POST …/glossary/analyse/stream — the run', () => {
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
    expect(slug).toBe('app_analyse_glossary_terms');
    expect(args).toMatchObject({
      questions: INPUT.questions,
      goal: INPUT.goal,
      existingTerms: ['shadow'],
      versionId: VID,
    });
    expect(context).toMatchObject({
      userId: 'admin-1',
      agentId: AGENT.id,
      entityContext: {
        glossaryAnalystAgent: { provider: 'openai', model: 'gpt-5.4' },
      },
    });
  });

  it('mentions the definitions document in the reading phase when one is attached', async () => {
    (buildGlossaryAnalysisInput as Mock).mockResolvedValue({
      ...INPUT,
      documentText: 'Higher self: the Self that observes.',
      documentFileName: 'glossary.pdf',
    });

    await invoke();
    const events = await drain();
    expect(events[0].message).toContain('definitions document');

    const [, args] = (capabilityDispatcher.dispatch as Mock).mock.calls[0];
    expect(args).toMatchObject({ documentFileName: 'glossary.pdf' });
  });

  it('persists the proposals and reports the counts on done', async () => {
    (persistProposedTerms as Mock).mockResolvedValue({
      proposedCount: 3,
      skippedExistingCount: 2,
      acceptedCount: 5,
    });

    await invoke();
    const events = await drain();

    expect(persistProposedTerms).toHaveBeenCalledWith(VID, ANALYSIS.terms, 'admin-1');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      versionId: VID,
      proposedCount: 3,
      // The number that lets the UI say "nothing new" rather than "nothing found".
      skippedExistingCount: 2,
      acceptedCount: 5,
    });
  });

  it('still persists (clearing stale proposals) when the analyst finds nothing', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { terms: [] } },
    });
    (persistProposedTerms as Mock).mockResolvedValue({
      proposedCount: 0,
      skippedExistingCount: 0,
      acceptedCount: 0,
    });

    await invoke();
    const events = await drain();

    // An empty result must still reach the writer — it is what retires a previous run's
    // proposals rather than leaving them stranded.
    expect(persistProposedTerms).toHaveBeenCalledWith(VID, [], 'admin-1');
    expect(events.at(-1)).toMatchObject({ type: 'done', proposedCount: 0 });
  });

  it('returns the full curated set on done, so the editor can render it', async () => {
    // A counts-only event would leave the admin reading "1 term to review" over an empty panel:
    // the editor seeds its state from a `useState` initialiser that never re-runs, and
    // `router.refresh()` preserves client state.
    await invoke();
    const events = await drain();

    expect(loadGlossaryTerms).toHaveBeenCalledWith(VID);
    expect(events.at(-1)).toMatchObject({ type: 'done', terms: CURATED_SET });
  });

  it('records provenance and an audit entry on success', async () => {
    await invoke();
    await drain();

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'version',
        subjectId: VID,
        kind: 'glossary_analysis',
        status: 'succeeded',
        triggeredByUserId: 'admin-1',
        detail: expect.objectContaining({ proposedCount: 1, usedDocument: false }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_glossary.analyse', entityId: VID })
    );
  });
});

// ─── Failure paths ────────────────────────────────────────────────────────────

describe('POST …/glossary/analyse/stream — failures', () => {
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
    expect(persistProposedTerms).not.toHaveBeenCalled();
  });

  it('records a failed run when the dispatch fails', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'No provider configured.' },
    });

    await invoke();
    await drain();

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'glossary_analysis', status: 'failed' })
    );
  });

  it('rejects a malformed capability payload rather than writing it', async () => {
    // A capability that changed shape must fail here, not persist half-formed rows.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { terms: [{ term: 'ego' }] } },
    });

    await invoke();
    const events = await drain();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'GLOSSARY_ANALYSIS_INVALID' });
    expect(persistProposedTerms).not.toHaveBeenCalled();
  });

  it('rejects a payload with no result at all', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({ success: true, data: {} });

    await invoke();
    const events = await drain();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'GLOSSARY_ANALYSIS_INVALID' });
    expect(persistProposedTerms).not.toHaveBeenCalled();
  });
});
