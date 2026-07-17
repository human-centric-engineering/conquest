/**
 * Unit tests for the generative-authoring compose API routes.
 *
 * Files under test:
 *   - app/api/v1/app/questionnaires/compose/route.ts (POST — non-streaming)
 *   - app/api/v1/app/questionnaires/compose/stream/route.ts (POST — SSE streaming)
 *   - app/api/v1/app/questionnaires/[id]/versions/[vid]/compose/refine/route.ts (POST — refine)
 *
 * Every collaborator is mocked at the module boundary. Tests assert what the route
 * DOES — status codes, response envelope shapes, collaborator call arguments — not
 * just what mocks return (anti-green-bar).
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
    appDemoClient: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
  },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  composeLimiter: { check: vi.fn(() => ({ success: true })) },
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/compose-pipeline', () => ({
  loadComposerAgent: vi.fn(),
  composeFromBrief: vi.fn(),
  loadRefinableStructure: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/persist', () => ({
  persistIngestion: vi.fn(),
  briefSource: vi.fn((brief: string) => ({
    fileName: 'brief.txt',
    fileHash: 'hash-of-brief',
    byteSize: brief.length,
    warnings: [],
    extractedText: brief,
  })),
  assertPersistable: vi.fn(),
  IncoherentExtractionError: class IncoherentExtractionError extends Error {
    orphanSectionOrdinals: number[];
    constructor(ordinals: number[]) {
      super('Incoherent structure');
      this.name = 'IncoherentExtractionError';
      this.orphanSectionOrdinals = ordinals;
    }
  },
  replaceVersionStructure: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/ingestion/stream-compose', () => ({
  streamComposeQuestionnaire: vi.fn(),
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG: 'app-questionnaire-composer',
}));

vi.mock('@/lib/api/sse', () => ({
  sseResponse: vi.fn((_events: AsyncIterable<unknown>) => new Response('sse', { status: 200 })),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  registerBuiltInCapabilities: vi.fn(),
}));

// ─── Deferred imports (after vi.mock) ────────────────────────────────────────

// Using `any` here avoids fighting Next.js handler overload union types in test context.
type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST: composePost } = (await import('@/app/api/v1/app/questionnaires/compose/route')) as {
  POST: AnyRouteHandler;
};
const { POST: streamPost } =
  (await import('@/app/api/v1/app/questionnaires/compose/stream/route')) as {
    POST: AnyRouteHandler;
  };
// Refine route uses dynamic params — we import it directly.
const { POST: refinePost } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/compose/refine/route')) as {
    POST: AnyRouteHandler;
  };

import { prisma } from '@/lib/db/client';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  loadComposerAgent,
  composeFromBrief,
  loadRefinableStructure,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import {
  persistIngestion,
  assertPersistable,
  replaceVersionStructure,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { sseResponse } from '@/lib/api/sse';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { streamComposeQuestionnaire } from '@/lib/app/questionnaire/ingestion/stream-compose';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };

function makeRequest(body: unknown, url = 'http://localhost/api/v1/app/questionnaires/compose') {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const AGENT = {
  id: 'agent-1',
  provider: 'anthropic',
  model: 'claude-opus',
  fallbackProviders: [] as string[],
};

const EXTRACTION = {
  sections: [{ ordinal: 0, title: 'General' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'q1',
      prompt: 'What is your role?',
      suggestedType: 'free_text' as const,
      extractionConfidence: 1,
    },
  ],
  changes: [],
  inferredGoal: 'Understand job roles',
};

const PERSIST_RESULT = {
  questionnaireId: 'qn-new',
  versionId: 'ver-new',
  sectionCount: 1,
  questionCount: 1,
  changeCount: 0,
  goal: 'Understand job roles',
  audience: null,
  fieldProvenance: { goal: 'inferred', audience: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: rate limit allows
  (composeLimiter.check as Mock).mockReturnValue({ success: true });
  // Default: no demo client in body
  (prisma.appDemoClient.findUnique as Mock).mockResolvedValue(null);
  // Default: agent found
  (loadComposerAgent as Mock).mockResolvedValue({ ok: true, value: AGENT });
  // Default: compose succeeds
  (composeFromBrief as Mock).mockResolvedValue({ ok: true, value: EXTRACTION });
  // Default: persist succeeds
  (persistIngestion as Mock).mockResolvedValue(PERSIST_RESULT);
  // Default: assertPersistable passes
  (assertPersistable as Mock).mockImplementation(() => undefined);
  // Default: replaceVersionStructure succeeds
  (replaceVersionStructure as Mock).mockResolvedValue({ sectionCount: 1, questionCount: 1 });
  // Default: capabilityDispatcher.dispatch succeeds with refined structure
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: {
      summary: 'Made it shorter',
      structure: {
        sections: [{ ordinal: 0, title: 'General' }],
        questions: [
          {
            sectionOrdinal: 0,
            key: 'q1',
            prompt: 'Role?',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
      },
    },
  });
  // Default: loadRefinableStructure returns a structure
  (loadRefinableStructure as Mock).mockResolvedValue({
    ok: true,
    value: {
      sections: [{ ordinal: 0, title: 'General' }],
      questions: [
        {
          sectionOrdinal: 0,
          key: 'q1',
          prompt: 'What is your role?',
          suggestedType: 'free_text',
          extractionConfidence: 1,
        },
      ],
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/app/questionnaires/compose (non-streaming)
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /compose (non-streaming)', () => {
  describe('rate limit', () => {
    it('returns 429 from createRateLimitResponse when composeLimiter rejects', async () => {
      (composeLimiter.check as Mock).mockReturnValue({
        success: false,
        reset: Date.now() + 60_000,
      });

      const req = makeRequest({ brief: 'Build a survey' });
      await composePost(req, ADMIN_SESSION);

      // The route must have called createRateLimitResponse — not just returned a generic 429.
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(composeLimiter.check).toHaveBeenCalledWith('admin-1');
      // Under the rate-limit path, no pipeline work should happen.
      expect(loadComposerAgent).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 VALIDATION_ERROR when body is absent', async () => {
      const req = new NextRequest('http://localhost/api/v1/app/questionnaires/compose', {
        method: 'POST',
      });
      const res = await composePost(req, ADMIN_SESSION);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(400);
      expect((body as { success: boolean }).success).toBe(false);
      expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      // No pipeline work on validation failure
      expect(loadComposerAgent).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when brief is empty string', async () => {
      const req = makeRequest({ brief: '' });
      const res = await composePost(req, ADMIN_SESSION);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when brief is missing', async () => {
      const req = makeRequest({ title: 'My form' });
      const res = await composePost(req, ADMIN_SESSION);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('demo-client pre-check', () => {
    it('returns 404 DEMO_CLIENT_NOT_FOUND when demoClientId does not exist in the DB', async () => {
      (prisma.appDemoClient.findUnique as Mock).mockResolvedValue(null);

      const req = makeRequest({ brief: 'Survey', demoClientId: 'client-missing' });
      const res = await composePost(req, ADMIN_SESSION);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(404);
      expect(body.error.code).toBe('DEMO_CLIENT_NOT_FOUND');
      // Pre-check bails before composer agent load
      expect(loadComposerAgent).not.toHaveBeenCalled();
      // Verifies it actually queried the client with the right id
      expect(prisma.appDemoClient.findUnique).toHaveBeenCalledWith({
        where: { id: 'client-missing' },
        select: { id: true },
      });
    });

    it('proceeds past the pre-check when demoClientId resolves to a real client', async () => {
      (prisma.appDemoClient.findUnique as Mock).mockResolvedValue({ id: 'client-1' });

      const req = makeRequest({ brief: 'Survey', demoClientId: 'client-1' });
      await composePost(req, ADMIN_SESSION);

      // Confirms the route continued to the agent load
      expect(loadComposerAgent).toHaveBeenCalled();
    });
  });

  describe('composer agent not configured', () => {
    it('returns the error response from loadComposerAgent when agent is missing', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'COMPOSER_NOT_CONFIGURED' } }),
        { status: 503 }
      );
      (loadComposerAgent as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const req = makeRequest({ brief: 'Build a survey' });
      const res = await composePost(req, ADMIN_SESSION);

      expect(res.status).toBe(503);
      expect(composeFromBrief).not.toHaveBeenCalled();
    });
  });

  describe('composeFromBrief failure', () => {
    it('returns the error response from composeFromBrief on dispatch failure', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'COMPOSITION_FAILED' } }),
        { status: 502 }
      );
      (composeFromBrief as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const req = makeRequest({ brief: 'Build a survey' });
      const res = await composePost(req, ADMIN_SESSION);

      expect(res.status).toBe(502);
      expect(persistIngestion).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('returns 201 with questionnaireId, versionId, counts, goal, audience, fieldProvenance', async () => {
      const req = makeRequest({ brief: 'Build a role survey' });
      const res = await composePost(req, ADMIN_SESSION);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          questionnaireId: string;
          versionId: string;
          sectionCount: number;
          questionCount: number;
          goal: string | null;
          audience: unknown;
          fieldProvenance: unknown;
        };
      };

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      // Verifies the route assembled the response from persistIngestion output
      expect(body.data.questionnaireId).toBe('qn-new');
      expect(body.data.versionId).toBe('ver-new');
      expect(body.data.sectionCount).toBe(1);
      expect(body.data.questionCount).toBe(1);
      expect(body.data.goal).toBe('Understand job roles');
      expect(body.data.fieldProvenance).toEqual({ goal: 'inferred', audience: {} });
    });

    it('calls composeFromBrief with the agent binding and adminId from session', async () => {
      const req = makeRequest({ brief: 'Staff survey', goal: 'Assess morale' });
      await composePost(req, ADMIN_SESSION);

      expect(composeFromBrief).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({
          brief: 'Staff survey',
          adminMeta: expect.objectContaining({ goal: 'Assess morale' }),
          adminId: 'admin-1',
        }),
        expect.anything() // logger
      );
    });

    it('calls logAdminAction with the questionnaire entity and counts', async () => {
      const req = makeRequest({ brief: 'Build a survey' });
      await composePost(req, ADMIN_SESSION);

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'questionnaire.compose',
          entityType: 'questionnaire',
          entityId: 'ver-new',
          metadata: expect.objectContaining({
            questionnaireId: 'qn-new',
            versionId: 'ver-new',
            sectionCount: 1,
            questionCount: 1,
          }),
        })
      );
    });

    it('passes demoClientId through to persistIngestion when client exists', async () => {
      (prisma.appDemoClient.findUnique as Mock).mockResolvedValue({ id: 'client-1' });

      const req = makeRequest({ brief: 'Demo survey', demoClientId: 'client-1' });
      await composePost(req, ADMIN_SESSION);

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ demoClientId: 'client-1' })
      );
    });

    it('omits demoClientId from persistIngestion when not supplied in body', async () => {
      const req = makeRequest({ brief: 'Generic survey' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('demoClientId');
    });

    it("defaults requiredness to 'all' when requiredAll is omitted (checkbox on by default)", async () => {
      const req = makeRequest({ brief: 'Default required survey' });
      await composePost(req, ADMIN_SESSION);

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ requiredness: 'all' })
      );
    });

    it("passes requiredness 'optional' when requiredAll is false", async () => {
      const req = makeRequest({ brief: 'All optional survey', requiredAll: false });
      await composePost(req, ADMIN_SESSION);

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ requiredness: 'optional' })
      );
    });
  });

  describe('deriveComposeTitle', () => {
    it('uses the admin-supplied title when provided', async () => {
      const req = makeRequest({ brief: 'Build a survey', title: 'My Custom Title' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('My Custom Title');
    });

    it('trims whitespace from the admin title', async () => {
      const req = makeRequest({ brief: 'Build a survey', title: '  Trimmed Title  ' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('Trimmed Title');
    });

    it('falls back to the inferred goal when no admin title given', async () => {
      (composeFromBrief as Mock).mockResolvedValue({
        ok: true,
        value: { ...EXTRACTION, inferredGoal: 'Survey health outcomes' },
      });

      const req = makeRequest({ brief: 'Build a health survey' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('Survey health outcomes');
    });

    it('truncates inferred goal to 79 chars + ellipsis when over 80 chars', async () => {
      const longGoal = 'A'.repeat(90);
      (composeFromBrief as Mock).mockResolvedValue({
        ok: true,
        value: { ...EXTRACTION, inferredGoal: longGoal },
      });

      const req = makeRequest({ brief: 'Long goal survey' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe(`${'A'.repeat(79)}…`);
    });

    it('falls back to "Untitled questionnaire" when no title and no inferred goal', async () => {
      (composeFromBrief as Mock).mockResolvedValue({
        ok: true,
        value: { ...EXTRACTION, inferredGoal: undefined },
      });

      const req = makeRequest({ brief: 'Brief without goal' });
      await composePost(req, ADMIN_SESSION);

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('Untitled questionnaire');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/app/questionnaires/compose/stream (SSE streaming)
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /compose/stream (SSE)', () => {
  describe('rate limit', () => {
    it('returns 429 from createRateLimitResponse when composeLimiter rejects', async () => {
      (composeLimiter.check as Mock).mockReturnValue({
        success: false,
        reset: Date.now() + 60_000,
      });

      const req = makeRequest({ brief: 'Survey' });
      await streamPost(req, ADMIN_SESSION);

      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(composeLimiter.check).toHaveBeenCalledWith('admin-1');
      expect(sseResponse).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 VALIDATION_ERROR when body has no brief', async () => {
      const req = new NextRequest('http://localhost/api/v1/app/questionnaires/compose/stream', {
        method: 'POST',
      });
      const res = await streamPost(req, ADMIN_SESSION);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('demo-client pre-check', () => {
    it('returns 404 DEMO_CLIENT_NOT_FOUND when demoClientId does not resolve', async () => {
      (prisma.appDemoClient.findUnique as Mock).mockResolvedValue(null);

      const req = makeRequest(
        { brief: 'Survey', demoClientId: 'missing-client' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      const res = await streamPost(req, ADMIN_SESSION);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(404);
      expect(body.error.code).toBe('DEMO_CLIENT_NOT_FOUND');
    });
  });

  describe('composer agent not configured', () => {
    it('returns the error from loadComposerAgent when agent is missing', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'COMPOSER_NOT_CONFIGURED' } }),
        { status: 503 }
      );
      (loadComposerAgent as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const req = makeRequest(
        { brief: 'Survey' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      const res = await streamPost(req, ADMIN_SESSION);

      expect(res.status).toBe(503);
      expect(sseResponse).not.toHaveBeenCalled();
    });
  });

  describe('happy path — drive() generator semantics', () => {
    it('calls sseResponse with the drive() async generator', async () => {
      // Arrange: stream emits one outline then returns the extraction as return value
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [{ ordinal: 0, title: 'G' }] };
        return EXTRACTION;
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      const req = makeRequest(
        { brief: 'Role survey' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      // sseResponse must have been called — the route converts drive() → SSE
      expect(sseResponse).toHaveBeenCalledOnce();
      const [eventsArg] = (sseResponse as Mock).mock.calls[0] as [AsyncIterable<unknown>];
      expect(eventsArg).toBeDefined();
    });

    it('drive() yields progress events then emits done with persisted ids', async () => {
      // Arrange: generator yields outline + section_done, then returns extraction
      const extraction = { ...EXTRACTION };
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [{ ordinal: 0, title: 'G' }] };
        yield { type: 'section_done' as const, ordinal: 0, title: 'G', questions: [] };
        return extraction;
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);
      (sseResponse as Mock).mockImplementation(
        (_events: AsyncIterable<unknown>) => new Response('streamed', { status: 200 })
      );

      // Intercept the generator passed to sseResponse by capturing it
      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Brief for stream' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      // Drain the captured generator to exercise the drive() logic
      expect(capturedGen).not.toBeNull();
      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      // The outline and section_done events should pass through
      expect(events[0]).toMatchObject({ type: 'outline' });
      expect(events[1]).toMatchObject({ type: 'section_done' });
      // The terminal done event carries the persisted ids
      const doneEvent = events[events.length - 1] as {
        type: string;
        questionnaireId: string;
        versionId: string;
      };
      expect(doneEvent.type).toBe('done');
      expect(doneEvent.questionnaireId).toBe('qn-new');
      expect(doneEvent.versionId).toBe('ver-new');
      // persistIngestion was called (the route did something with the extraction)
      expect(persistIngestion).toHaveBeenCalledOnce();
    });

    it('drive() stops early (no persist, no done) when the generator yields an error event', async () => {
      // Arrange: generator yields an error event
      const fakeGen = (async function* () {
        yield { type: 'error' as const, code: 'outline_failed', message: 'Provider down' };
        return { ...EXTRACTION }; // return value exists but should be ignored
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Failing brief' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      // The error event passes through
      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe('error');
      // Fatal: generator stopped early, no persist
      expect(persistIngestion).not.toHaveBeenCalled();
    });

    it('drive() yields error event with code persist_failed when persistIngestion throws', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [{ ordinal: 0, title: 'G' }] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);
      (persistIngestion as Mock).mockRejectedValue(new Error('DB connection lost'));

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Persist fails' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      // The outline passes through, then an error event with persist_failed code
      expect(events[0]).toMatchObject({ type: 'outline' });
      const errEvent = events[events.length - 1] as { type: string; code: string };
      expect(errEvent.type).toBe('error');
      expect(errEvent.code).toBe('persist_failed');
      // No done event
      expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(false);
    });

    it('calls logAdminAction after successful persist in drive()', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Audit test' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      // Drain generator to trigger the persist + logAdminAction
      for await (const _ of capturedGen!) {
        /* drain */
      }

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'questionnaire.compose',
          entityType: 'questionnaire',
          entityId: 'ver-new',
          metadata: expect.objectContaining({ mode: 'stream' }),
        })
      );
    });

    it('passes demoClientId to persistIngestion inside drive() when client exists', async () => {
      (prisma.appDemoClient.findUnique as Mock).mockResolvedValue({ id: 'client-stream-1' });

      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Demo stream survey', demoClientId: 'client-stream-1' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ demoClientId: 'client-stream-1' })
      );
    });

    it('drive() uses the admin title inside the stream persist when title provided', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION, inferredGoal: 'Inferred (should be ignored)' };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Title test', title: 'My Stream Title' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('My Stream Title');
    });

    it('drive() uses inferred goal as title when no admin title is provided', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION, inferredGoal: 'Inferred stream goal' };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Goal test' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('Inferred stream goal');
    });

    it('passes goal and audience to streamComposeQuestionnaire via adminSupplied when provided', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Admin meta test', goal: 'Track safety', audience: { role: 'nurse' } },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      // streamComposeQuestionnaire should receive the adminSupplied shape
      expect(streamComposeQuestionnaire).toHaveBeenCalledWith(
        expect.objectContaining({
          adminSupplied: { goal: 'Track safety', audience: { role: 'nurse' } },
        })
      );
      // And the admin goal/audience should appear in the persistIngestion call
      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({
          admin: { goal: 'Track safety', audience: { role: 'nurse' } },
        })
      );
    });

    it('drive() yields error with persist_failed code when persistIngestion throws a non-Error', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);
      // Throw a string (not an Error instance) to cover the String(err) branch
      (persistIngestion as Mock).mockRejectedValue('string error');

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Non-Error throw' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);

      const events: unknown[] = [];
      for await (const ev of capturedGen!) {
        events.push(ev);
      }

      const errEvent = events[events.length - 1] as { type: string; code: string };
      expect(errEvent.type).toBe('error');
      expect(errEvent.code).toBe('persist_failed');
    });

    it("drive() defaults requiredness to 'all' when requiredAll is omitted", async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Stream default required' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ requiredness: 'all' })
      );
    });

    it("drive() passes requiredness 'optional' when requiredAll is false", async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'Stream all optional', requiredAll: false },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      expect(persistIngestion).toHaveBeenCalledWith(
        expect.objectContaining({ requiredness: 'optional' })
      );
    });

    it('drive() falls back to "Untitled questionnaire" when no title or inferred goal', async () => {
      const fakeGen = (async function* () {
        yield { type: 'outline' as const, sections: [] };
        return { ...EXTRACTION, inferredGoal: undefined };
      })();
      (streamComposeQuestionnaire as Mock).mockReturnValue(fakeGen);

      let capturedGen: AsyncGenerator<unknown> | null = null;
      (sseResponse as Mock).mockImplementationOnce((events: AsyncGenerator<unknown>) => {
        capturedGen = events;
        return new Response('sse-ok', { status: 200 });
      });

      const req = makeRequest(
        { brief: 'No title or goal' },
        'http://localhost/api/v1/app/questionnaires/compose/stream'
      );
      await streamPost(req, ADMIN_SESSION);
      for await (const _ of capturedGen!) {
        /* drain */
      }

      const call = (persistIngestion as Mock).mock.calls[0][0] as { documentTitle: string };
      expect(call.documentTitle).toBe('Untitled questionnaire');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/app/questionnaires/[id]/versions/[vid]/compose/refine
// ═════════════════════════════════════════════════════════════════════════════

/** Build a refine route request with the nested params structure Next.js provides. */
function makeRefineRequest(body: unknown, id = 'qn-1', vid = 'ver-1') {
  const req = new NextRequest(
    `http://localhost/api/v1/app/questionnaires/${id}/versions/${vid}/compose/refine`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  );
  const context = { params: Promise.resolve({ id, vid }) };
  return { req, context };
}

/**
 * Invoke the refine POST handler. Because withAdminAuth is mocked to an identity
 * function, POST is the bare handler with signature (request, session, context).
 * We call it with all three arguments.
 */
async function callRefine(
  req: NextRequest,
  context: { params: Promise<{ id: string; vid: string }> }
): Promise<Response> {
  return refinePost(req, ADMIN_SESSION, context);
}

describe('POST /[id]/versions/[vid]/compose/refine', () => {
  describe('rate limit', () => {
    it('returns 429 from createRateLimitResponse when composeLimiter rejects', async () => {
      (composeLimiter.check as Mock).mockReturnValue({
        success: false,
        reset: Date.now() + 60_000,
      });

      const { req, context } = makeRefineRequest({ instruction: 'Make it shorter' });
      await callRefine(req, context);

      expect(createRateLimitResponse).toHaveBeenCalledOnce();
      expect(loadRefinableStructure).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 VALIDATION_ERROR when body has no instruction', async () => {
      const { req, context } = makeRefineRequest({});
      const res = await callRefine(req, context);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when instruction is empty string', async () => {
      const { req, context } = makeRefineRequest({ instruction: '' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as { success: boolean; error: { code: string } };

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('loadRefinableStructure guards', () => {
    it('returns 404 from loadRefinableStructure when version not found', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }),
        { status: 404 }
      );
      (loadRefinableStructure as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const { req, context } = makeRefineRequest({ instruction: 'Make it shorter' });
      const res = await callRefine(req, context);

      expect(res.status).toBe(404);
      // Should not proceed to agent load when structure fails
      expect(loadComposerAgent).not.toHaveBeenCalled();
    });

    it('returns 409 from loadRefinableStructure when version is not a draft', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'REFINE_REQUIRES_DRAFT' } }),
        { status: 409 }
      );
      (loadRefinableStructure as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const { req, context } = makeRefineRequest({ instruction: 'Add a section' });
      const res = await callRefine(req, context);

      expect(res.status).toBe(409);
      expect(loadComposerAgent).not.toHaveBeenCalled();
    });

    it('returns 409 from loadRefinableStructure when version has sessions', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'REFINE_HAS_SESSIONS' } }),
        { status: 409 }
      );
      (loadRefinableStructure as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const { req, context } = makeRefineRequest({ instruction: 'Add pricing section' });
      const res = await callRefine(req, context);

      expect(res.status).toBe(409);
      expect(loadComposerAgent).not.toHaveBeenCalled();
    });
  });

  describe('composer agent not configured', () => {
    it('returns 503 from loadComposerAgent when composer is not seeded', async () => {
      const errorResp = new Response(
        JSON.stringify({ success: false, error: { code: 'COMPOSER_NOT_CONFIGURED' } }),
        { status: 503 }
      );
      (loadComposerAgent as Mock).mockResolvedValue({ ok: false, response: errorResp });

      const { req, context } = makeRefineRequest({ instruction: 'Shorten it' });
      const res = await callRefine(req, context);

      expect(res.status).toBe(503);
      expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('dispatchStatus mapping', () => {
    const cases = [
      { code: 'rate_limited', expectedStatus: 429 },
      { code: 'invalid_args', expectedStatus: 400 },
      { code: 'no_provider_configured', expectedStatus: 503 },
      { code: 'provider_unavailable', expectedStatus: 503 },
      { code: 'capability_inactive', expectedStatus: 503 },
      { code: 'capability_disabled_for_agent', expectedStatus: 503 },
      { code: 'unknown_capability', expectedStatus: 503 },
      { code: 'capability_quarantined', expectedStatus: 503 },
      { code: 'requires_approval', expectedStatus: 503 },
      { code: 'some_unknown_error', expectedStatus: 502 },
    ];

    for (const { code, expectedStatus } of cases) {
      it(`maps dispatch error code '${code}' → HTTP ${expectedStatus}`, async () => {
        (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
          success: false,
          error: { code, message: `Dispatch failed: ${code}` },
        });

        const { req, context } = makeRefineRequest({ instruction: 'Improve it' });
        const res = await callRefine(req, context);
        const body = (await res.json()) as { success: boolean; error: { code: string } };

        // Verify the HTTP status from dispatchStatus mapping
        expect(res.status).toBe(expectedStatus);
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('REFINEMENT_FAILED');
        // No structure write on dispatch failure
        expect(replaceVersionStructure).not.toHaveBeenCalled();
      });
    }

    it('returns 502 REFINEMENT_FAILED without details when dispatch error has no code', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: false,
        error: { message: 'Unknown failure' }, // no code
      });

      const { req, context } = makeRefineRequest({ instruction: 'Improve it' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as {
        success: boolean;
        error: { code: string; details?: unknown };
      };

      expect(res.status).toBe(502);
      expect(body.error.code).toBe('REFINEMENT_FAILED');
      // No details when error code is absent
      expect(body.error).not.toHaveProperty('details');
    });
  });

  describe('assertPersistable IncoherentExtractionError', () => {
    it('returns 422 REFINEMENT_INCOHERENT with orphan ordinals when structure is incoherent', async () => {
      // Arrange: dispatch succeeds but structure has orphan questions
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: {
          summary: 'Rewrote everything',
          structure: {
            sections: [{ ordinal: 0, title: 'A' }],
            questions: [
              {
                sectionOrdinal: 99,
                key: 'orphan',
                prompt: 'P',
                suggestedType: 'free_text',
                extractionConfidence: 1,
              },
            ],
          },
        },
      });
      // assertPersistable throws IncoherentExtractionError
      (assertPersistable as Mock).mockImplementation(() => {
        throw new IncoherentExtractionError([99]);
      });

      const { req, context } = makeRefineRequest({ instruction: 'Restructure it' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as {
        success: boolean;
        error: { code: string; details: { orphanSectionOrdinals: number[] } };
      };

      expect(res.status).toBe(422);
      expect(body.error.code).toBe('REFINEMENT_INCOHERENT');
      expect(body.error.details.orphanSectionOrdinals).toEqual([99]);
      // No write when incoherent
      expect(replaceVersionStructure).not.toHaveBeenCalled();
    });

    it('rethrows non-IncoherentExtractionError exceptions from assertPersistable', async () => {
      (assertPersistable as Mock).mockImplementation(() => {
        throw new TypeError('Unexpected assertion error');
      });

      const { req, context } = makeRefineRequest({ instruction: 'Trigger rethrow' });
      await expect(callRefine(req, context)).rejects.toThrow(TypeError);
    });
  });

  describe('happy path', () => {
    it('returns 200 with summary, sectionCount, questionCount, and structure', async () => {
      const { req, context } = makeRefineRequest({ instruction: 'Make it shorter' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          summary: string;
          sectionCount: number;
          questionCount: number;
          structure: {
            sections: unknown[];
            questions: unknown[];
          };
        };
      };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.summary).toBe('Made it shorter');
      expect(body.data.sectionCount).toBe(1);
      expect(body.data.questionCount).toBe(1);
      expect(body.data.structure.sections).toBeDefined();
      expect(body.data.structure.questions).toBeDefined();
    });

    it('calls registerBuiltInCapabilities before dispatch', async () => {
      const { req, context } = makeRefineRequest({ instruction: 'Improve wording' });
      await callRefine(req, context);

      expect(registerBuiltInCapabilities).toHaveBeenCalledOnce();
    });

    it('dispatches the refine capability with currentStructure, instruction, and agent binding', async () => {
      const { req, context } = makeRefineRequest({ instruction: 'Add pricing section' });
      await callRefine(req, context);

      expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
        'app_refine_questionnaire_structure',
        expect.objectContaining({
          instruction: 'Add pricing section',
          currentStructure: expect.objectContaining({
            sections: expect.any(Array),
            questions: expect.any(Array),
          }),
        }),
        expect.objectContaining({
          userId: 'admin-1',
          agentId: 'agent-1',
          entityContext: expect.objectContaining({
            composerAgent: expect.objectContaining({
              provider: 'anthropic',
              model: 'claude-opus',
            }),
          }),
        })
      );
    });

    it('calls replaceVersionStructure with the version id and refined structure', async () => {
      const { req, context } = makeRefineRequest({ instruction: 'Shorten' }, 'qn-1', 'ver-1');
      await callRefine(req, context);

      expect(replaceVersionStructure).toHaveBeenCalledWith(
        'ver-1',
        expect.objectContaining({
          sections: expect.any(Array),
          questions: expect.any(Array),
        })
      );
    });

    it('calls logAdminAction with questionnaire.refine action and counts', async () => {
      const { req, context } = makeRefineRequest(
        { instruction: 'Remove duplicates' },
        'qn-1',
        'ver-1'
      );
      await callRefine(req, context);

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'questionnaire.refine',
          entityType: 'questionnaire',
          entityId: 'ver-1',
          metadata: expect.objectContaining({
            questionnaireId: 'qn-1',
            versionId: 'ver-1',
            sectionCount: 1,
            questionCount: 1,
          }),
        })
      );
    });

    it('includes inferred goal and audience in structure response when present', async () => {
      (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
        success: true,
        data: {
          summary: 'Expanded with audience',
          structure: {
            sections: [{ ordinal: 0, title: 'G' }],
            questions: [
              {
                sectionOrdinal: 0,
                key: 'q1',
                prompt: 'P',
                suggestedType: 'free_text',
                extractionConfidence: 1,
              },
            ],
            inferredGoal: 'Collect patient feedback',
            inferredAudience: { role: 'patient' },
          },
        },
      });

      const { req, context } = makeRefineRequest({ instruction: 'Tailor to patients' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as {
        success: boolean;
        data: { structure: { goal?: string; audience?: unknown } };
      };

      expect(body.data.structure).toHaveProperty('goal', 'Collect patient feedback');
      expect(body.data.structure).toHaveProperty('audience');
    });

    it('omits goal and audience from structure response when not present', async () => {
      // Default dispatch mock has no inferredGoal/inferredAudience on structure
      const { req, context } = makeRefineRequest({ instruction: 'Keep it plain' });
      const res = await callRefine(req, context);
      const body = (await res.json()) as {
        success: boolean;
        data: { structure: Record<string, unknown> };
      };

      expect(body.data.structure).not.toHaveProperty('goal');
      expect(body.data.structure).not.toHaveProperty('audience');
    });
  });
});
