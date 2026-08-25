/**
 * Integration test: POST /api/v1/app/questionnaires/stream (SSE streaming ingest twin).
 *
 * The streaming route shares the exact pre-stream pipeline with the non-streaming
 * `POST /questionnaires` route (see `route.test.ts` in the parent folder):
 * admin auth, per-admin rate cap, multipart guard, demo-client existence check. Those
 * gates all still return a normal JSON error envelope BEFORE the stream opens. Once the
 * stream opens (`sseResponse` returns 200), extraction/persist failures surface as a
 * terminal `event: error` frame instead of an HTTP error status, and success surfaces as
 * a terminal `event: done` frame carrying the persisted draft's ids + counts.
 *
 * Covers: 401 unauth · 403 non-admin · 429 rate-limit · 400 missing-file ·
 * 400 unsupported-format · 413 oversize · 404 demo-client-not-found (all pre-stream JSON) ·
 * happy-path SSE done frame + persistence wiring · extractor-failure error frame ·
 * persist-failure error frame (both still HTTP 200, stream already opened).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

import { parseSseBlock, type ParsedSseEvent } from '@/lib/api/sse-parser';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appDemoClient: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/lib/app/questionnaire/ingestion/xlsx-flatten', () => ({ flattenWorkbook: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

// Keep assertPersistable + IncoherentExtractionError real; mock only the writer.
vi.mock('@/app/api/v1/app/questionnaires/_lib/persist', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/persist')>();
  return { ...real, persistIngestion: vi.fn() };
});

// Default-allow limiter; individual tests can flip it to a rejection.
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  INGEST_RATE_LIMIT_MAX: 10,
  INGEST_RATE_LIMIT_INTERVAL_MS: 60_000,
}));

// Conditional Topics candidacy (P17.19) is mocked at the module boundary — its own Prisma-branch
// logic is unit-tested in `_lib/scope-candidacy.test.ts`. These integration tests only prove
// the stream route wires the result into the `checking_scope` phase + terminal `done` frame.
vi.mock('@/app/api/v1/app/questionnaires/_lib/routing-analysis', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/routing-analysis')>();
  // `canProposeDuringIngest` stays REAL — it is the elapsed-time gate this route depends on, and
  // stubbing it would make the "skips when the budget is spent" test assert nothing.
  return { ...real, proposeScopeDuringIngest: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/scope-candidacy', () => ({
  checkConditionalTopicsCandidacy: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/stream/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { persistIngestion } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { checkConditionalTopicsCandidacy } from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';
import { proposeScopeDuringIngest } from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(
  fileName: string | null,
  content = '# Form\n1. Name',
  mimeType = 'text/markdown',
  extraFields: Record<string, string> = {},
  headerOverrides: Record<string, string> = {}
): NextRequest {
  const formData = new FormData();
  if (fileName !== null) {
    formData.set('file', new File([content], fileName, { type: mimeType }));
  }
  for (const [k, v] of Object.entries(extraFields)) formData.set(k, v);

  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'multipart/form-data', ...headerOverrides }),
    url: 'http://localhost:3000/api/v1/app/questionnaires/stream',
    signal: new AbortController().signal,
    formData: async () => formData,
  } as unknown as NextRequest;
}

/** A coherent extraction (questions map to declared sections). */
const COHERENT_EXTRACTION = {
  sections: [{ ordinal: 0, title: 'About You' }],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'name',
      prompt: 'What is your name?',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
  ],
  inferredGoal: 'Collect details',
  inferredAudience: { role: 'new hire' },
  changes: [
    { changeType: 'infer_goal', targetEntityType: 'version', afterJson: 'Collect details' },
  ],
};

const PERSIST_RESULT = {
  questionnaireId: 'qn-1',
  versionId: 'ver-1',
  sectionCount: 1,
  questionCount: 1,
  changeCount: 1,
  goal: 'Collect details',
  audience: { role: 'new hire' },
  fieldProvenance: { goal: 'inferred', audience: { role: 'inferred' } },
};

const PARSED_DOC = {
  title: 'Onboarding',
  sections: [{ title: '', content: '# Form', order: 0 }],
  fullText: '# Form\n1. Name',
  metadata: { format: 'markdown' },
  warnings: [],
};

function setAdmin() {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
}

/** Drain an SSE `Response` body into an ordered list of parsed frames. */
async function drainSse(res: Response): Promise<ParsedSseEvent[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => parseSseBlock(block))
    .filter((e): e is ParsedSseEvent => e !== null);
}

beforeEach(() => {
  vi.clearAllMocks();
  setAdmin();
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  (prisma.appDemoClient.findUnique as Mock).mockResolvedValue({ id: 'client-1' }); // exists by default
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    id: 'agent-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC });
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: structuredClone(COHERENT_EXTRACTION),
  });
  (persistIngestion as Mock).mockResolvedValue(PERSIST_RESULT);
  // Default: not a candidate / check skipped — keeps every pre-existing test's frame
  // sequence and done-event shape unchanged (no `conditionalTopicsCandidate` key) untouched.
  (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(null);
  (proposeScopeDuringIngest as Mock).mockResolvedValue(null);
});

// ─── Gate + auth (pre-stream — JSON envelope, not SSE) ─────────────────────────

describe('POST /api/v1/app/questionnaires/stream — gate and auth', () => {
  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(401);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(403);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Rate limit (pre-stream) ────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/stream — rate limit', () => {
  it('returns 429 when the per-admin ingest sub-cap is exceeded, before any stream opens', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(429);
    // Rate-limited before any parse/dispatch work, and not an SSE response.
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    expect(parseDocument).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Input / upload failure modes (pre-stream JSON envelope) ────────────────────

describe('POST /api/v1/app/questionnaires/stream — input failures', () => {
  it('returns 400 when the file field is missing', async () => {
    const res = await POST(makeRequest(null));

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 400 UNSUPPORTED_FORMAT for a disallowed extension', async () => {
    const res = await POST(makeRequest('photo.png', 'binary', 'image/png'));

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    const body = await res.json();
    expect(body.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns 413 FILE_TOO_LARGE on an oversize Content-Length', async () => {
    const res = await POST(
      makeRequest(
        'form.md',
        '# Form',
        'text/markdown',
        {},
        { 'content-length': String(200 * 1024 * 1024) }
      )
    );

    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    const body = await res.json();
    expect(body.error.code).toBe('FILE_TOO_LARGE');
  });
});

// ─── Demo-client attribution pre-check (pre-stream) ─────────────────────────────

describe('POST /api/v1/app/questionnaires/stream — demo-client pre-check', () => {
  it('returns 404 DEMO_CLIENT_NOT_FOUND and does no extraction when the client is unknown', async () => {
    (prisma.appDemoClient.findUnique as Mock).mockResolvedValue(null);

    const res = await POST(
      makeRequest('form.md', '# Form', 'text/markdown', { demoClientId: 'ghost' })
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    const body = await res.json();
    expect(body.error.code).toBe('DEMO_CLIENT_NOT_FOUND');
    // Rejected before the expensive parse/dispatch/persist work — and before any stream opens.
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(persistIngestion).not.toHaveBeenCalled();
  });
});

// ─── Happy path (SSE) ────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/stream — happy path', () => {
  it('streams text/event-stream and emits a terminal done frame with ids + counts', async () => {
    const res = await POST(makeRequest('onboarding.md'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await drainSse(res);
    const eventTypes = frames.map((f) => f.type);

    // Progress phases precede the terminal frame.
    expect(eventTypes).toContain('phase');
    expect(eventTypes[eventTypes.length - 1]).toBe('done');
    expect(eventTypes).not.toContain('error');

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.data).toEqual({
      type: 'done',
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 1,
      questionCount: 1,
      changeCount: 1,
    });
  });

  it('persists the extracted graph via persistIngestion with the parsed source + admin metadata', async () => {
    const res = await POST(makeRequest('onboarding.md'));
    await drainSse(res); // drive the async generator to completion

    // Same wiring proof as the non-streaming route: dispatch got the parsed text + file
    // name, and persist got the validated extraction plus source provenance.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'app_extract_questionnaire_structure',
      expect.objectContaining({ documentText: PARSED_DOC.fullText, fileName: 'onboarding.md' }),
      expect.objectContaining({ userId: ADMIN_ID, agentId: 'agent-1' })
    );
    expect(persistIngestion).toHaveBeenCalledTimes(1);
    expect(persistIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        documentTitle: 'Onboarding',
        extraction: expect.objectContaining({ sections: expect.any(Array) }),
        source: expect.objectContaining({
          fileName: 'onboarding.md',
          fileHash: expect.any(String),
          extractedText: PARSED_DOC.fullText,
        }),
      })
    );
  });

  it('writes an admin audit row tagged mode: stream with the ingest counts', async () => {
    const res = await POST(makeRequest('onboarding.md'));
    await drainSse(res);

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'questionnaire.ingest',
        entityType: 'questionnaire',
        entityId: 'ver-1',
        clientIp: '203.0.113.7',
        metadata: expect.objectContaining({
          questionnaireId: 'qn-1',
          versionId: 'ver-1',
          sectionCount: 1,
          questionCount: 1,
          changeCount: 1,
          mode: 'stream',
        }),
      })
    );
  });

  it('attributes the questionnaire to the demo client and persists its id when supplied', async () => {
    const res = await POST(
      makeRequest('form.md', '# Form', 'text/markdown', { demoClientId: 'client-1' })
    );
    await drainSse(res);

    expect(prisma.appDemoClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-1' } })
    );
    expect(persistIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ demoClientId: 'client-1' })
    );
  });
});

// ─── Mid-stream failures (still HTTP 200 — the stream already opened) ──────────

describe('POST /api/v1/app/questionnaires/stream — extraction failure mid-stream', () => {
  it('emits a terminal error frame (not a done frame) when the extractor dispatch fails, HTTP status stays 200', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'rate_limited', message: 'Extractor is rate limited' },
    });

    const res = await POST(makeRequest('form.md'));

    // The stream already opened — status is 200, not the 429 the non-streaming route
    // would return for the same dispatch error.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await drainSse(res);
    const errorFrame = frames.find((f) => f.type === 'error');
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.data).toMatchObject({
      type: 'error',
      code: 'EXTRACTOR_RATE_LIMITED',
      message: 'Extractor is rate limited',
    });
    // No terminal success frame, and no persistence happened.
    expect(frames.some((f) => f.type === 'done')).toBe(false);
    expect(persistIngestion).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/app/questionnaires/stream — persist failure mid-stream', () => {
  it('emits a terminal error frame with PERSIST_FAILED when persistIngestion throws, HTTP status stays 200', async () => {
    (persistIngestion as Mock).mockRejectedValue(new Error('DB connection lost'));

    const res = await POST(makeRequest('form.md'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await drainSse(res);
    const errorFrame = frames.find((f) => f.type === 'error');
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.data).toMatchObject({
      type: 'error',
      code: 'PERSIST_FAILED',
    });
    // Extraction did run (dispatch was reached) even though the write failed.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalled();
    expect(frames.some((f) => f.type === 'done')).toBe(false);
    // The raw DB error message is never forwarded onto the wire.
    expect(JSON.stringify(frames)).not.toContain('DB connection lost');
  });
});

// ─── Conditional Topics candidacy wiring (P17.19) ───────────────────────────────────
// `checkConditionalTopicsCandidacy` itself is mocked at the module boundary — its Prisma-branch
// logic is unit-tested in `_lib/scope-candidacy.test.ts`. These tests only prove this route
// wires the result into its own `checking_scope` phase frame and terminal `done` frame.

describe('POST /api/v1/app/questionnaires/stream — conditional topics candidacy wiring', () => {
  it('emits a checking_scope phase frame between saving and the terminal done frame', async () => {
    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const phaseNames = frames.filter((f) => f.type === 'phase').map((f) => f.data.phase);
    const savingIndex = phaseNames.indexOf('saving');
    const checkingIndex = phaseNames.indexOf('checking_scope');

    expect(savingIndex).toBeGreaterThanOrEqual(0);
    expect(checkingIndex).toBeGreaterThan(savingIndex);
    expect(frames[frames.length - 1].type).toBe('done');
  });

  it('carries conditionalTopicsCandidate on the done frame when the check resolves a verdict', async () => {
    const verdict = { isCandidate: true, confidence: 0.8, summary: 'Has conditional branches.' };
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(verdict);

    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect(doneFrame.data.conditionalTopicsCandidate).toEqual(verdict);
  });

  it('omits conditionalTopicsCandidate from the done frame when the check resolves null', async () => {
    // beforeEach already defaults the mock to null — pins the omission (not
    // present-and-undefined) directly against the parsed SSE frame data.
    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect('conditionalTopicsCandidate' in doneFrame.data).toBe(false);
  });
});

// ─── Proposing during the upload (F17.22 Phase 2) ────────────────────────────────

describe('POST /api/v1/app/questionnaires/stream — proposing scope during the upload', () => {
  const CANDIDATE = { isCandidate: true, confidence: 0.8, summary: 'Has conditional branches.' };

  it('runs the analyst after the check says yes, and reports what it proposed', async () => {
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(CANDIDATE);
    (proposeScopeDuringIngest as Mock).mockResolvedValue({ topicCount: 6, conditionalCount: 3 });

    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const phaseNames = frames.filter((f) => f.type === 'phase').map((f) => f.data.phase);
    // Order matters: the admin sees "checking" resolve into "proposing" rather than a stall.
    expect(phaseNames.indexOf('proposing_scope')).toBeGreaterThan(
      phaseNames.indexOf('checking_scope')
    );

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect(doneFrame.data.conditionalTopicsProposal).toEqual({
      topicCount: 6,
      conditionalCount: 3,
    });
  });

  it('never runs the analyst when the check declined', async () => {
    // The analyst is a reasoning-tier call over the whole document. Running it on every upload
    // regardless of the verdict is exactly the cost the cheap triage check exists to avoid.
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue({
      ...CANDIDATE,
      isCandidate: false,
    });

    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    expect(proposeScopeDuringIngest).not.toHaveBeenCalled();
    expect(frames.filter((f) => f.type === 'phase').map((f) => f.data.phase)).not.toContain(
      'proposing_scope'
    );
  });

  it('skips the proposal when the ingest has already spent the wall-clock budget', async () => {
    // Being killed mid-`proposing_scope` is the failure worth avoiding: the version is persisted
    // but the client never sees `done`, so the dialog reports a failed upload for a questionnaire
    // that exists. Skipping costs only latency — the cached verdict makes the Topics tab propose.
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(CANDIDATE);
    const realNow = Date.now;
    // A clock that jumps a minute and a half per read: whatever else in the pipeline reads it, the
    // gap between the stream's start and the pre-proposal check is past the threshold.
    let ticks = 0;
    Date.now = () => ticks++ * 90_000;

    try {
      const res = await POST(makeRequest('onboarding.md'));
      const frames = await drainSse(res);

      expect(proposeScopeDuringIngest).not.toHaveBeenCalled();
      expect(frames.filter((f) => f.type === 'phase').map((f) => f.data.phase)).not.toContain(
        'proposing_scope'
      );
      expect(frames[frames.length - 1].type).toBe('done');
    } finally {
      Date.now = realNow;
    }
  });

  it('reports what it proposed as a second phase message', async () => {
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(CANDIDATE);
    (proposeScopeDuringIngest as Mock).mockResolvedValue({ topicCount: 6, conditionalCount: 3 });

    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const messages = frames.filter((f) => f.type === 'phase').map((f) => f.data.message);
    expect(messages.some((m) => String(m).includes('6 topics, 3 of them conditional'))).toBe(true);
  });

  it('completes the upload when the proposal fails', async () => {
    // Fail-soft is the whole contract: an upload that succeeded must never be reported as failed
    // because an optional proposal could not be made.
    (checkConditionalTopicsCandidacy as Mock).mockResolvedValue(CANDIDATE);
    (proposeScopeDuringIngest as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('onboarding.md'));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect('conditionalTopicsProposal' in doneFrame.data).toBe(false);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});
