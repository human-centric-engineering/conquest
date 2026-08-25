/**
 * Integration test: POST /api/v1/app/questionnaires/:id/versions/:vid/reingest/stream
 * — the SSE streaming twin of F2.4's re-ingest.
 *
 * The streaming route shares the exact pre-stream gate chain with the non-streaming
 * `POST …/reingest` (see `../reingest-routes.test.ts`): admin auth, per-admin rate cap,
 * scope-404, draft-only 409, multipart guard, version-scoped SHA-256 dedup. Those all
 * still resolve BEFORE the stream opens, so their failures are ordinary JSON envelopes.
 * Once the stream opens (`sseResponse` returns 200), extraction/replace failures surface
 * as a terminal `event: error` frame instead of an HTTP error status, and success as a
 * terminal `event: done` frame carrying the version's counts.
 *
 * Covers: 401 · 403 · 429 · 404 unknown version · 409 non-draft · 400 missing file ·
 * happy-path SSE (real phase frames + done + writer/audit wiring) · dedup no-op as a
 * `done { deduped: true }` frame with no extraction and no write · extractor failure and
 * the mid-flight-launch TOCTOU as terminal error frames (both still HTTP 200).
 */

import { createHash } from 'node:crypto';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

import { parseSseBlock, type ParsedSseEvent } from '@/lib/api/sse-parser';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: { findFirst: vi.fn() },
    appQuestionnaireSourceDocument: { findFirst: vi.fn() },
    appQuestionnaireSection: { count: vi.fn() },
    appQuestionSlot: { count: vi.fn() },
    appQuestionnaireExtractionChange: { count: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

// Mock only the writer; keep the REAL ReingestNotDraftError so the route's `instanceof`
// wiring is exercised against the real class, not a hand-rolled stand-in.
vi.mock('@/app/api/v1/app/questionnaires/_lib/reingest', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/reingest')>();
  return { ...real, reingestVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
  INGEST_RATE_LIMIT_MAX: 10,
  INGEST_RATE_LIMIT_INTERVAL_MS: 60_000,
}));

// Adaptive Scope candidacy (P17.19) is mocked at the module boundary — its own Prisma-branch
// logic is unit-tested in `_lib/scope-candidacy.test.ts`. These integration tests only prove
// the stream route wires the result into the `checking_scope` phase + terminal `done` frame.
vi.mock('@/app/api/v1/app/questionnaires/_lib/routing-analysis', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/routing-analysis')>();
  // `canProposeDuringIngest` stays REAL — the elapsed-time gate is what this route depends on.
  return { ...real, proposeScopeDuringIngest: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/scope-candidacy', () => ({
  checkAdaptiveScopeCandidacy: vi.fn(),
  isEligibleForScopeCandidacy: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/reingest/stream/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  reingestVersion,
  ReingestNotDraftError,
} from '@/app/api/v1/app/questionnaires/_lib/reingest';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  checkAdaptiveScopeCandidacy,
  isEligibleForScopeCandidacy,
} from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';
import { proposeScopeDuringIngest } from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const PARAMS = { id: 'qn-1', vid: 'ver-1' };
const DOC = '# Form\n1. Name';

function ctx(params: { id: string; vid: string }): {
  params: Promise<{ id: string; vid: string }>;
} {
  return { params: Promise.resolve(params) };
}

/** The route hashes the raw upload bytes; mirror that to drive the dedup branch. */
function hashOf(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function makeRequest(
  fileName: string | null,
  content = DOC,
  mimeType = 'text/markdown',
  extraFields: Record<string, string> = {}
): NextRequest {
  const formData = new FormData();
  if (fileName !== null) {
    formData.set('file', new File([content], fileName, { type: mimeType }));
  }
  for (const [k, v] of Object.entries(extraFields)) formData.set(k, v);

  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'multipart/form-data' }),
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/ver-1/reingest/stream',
    signal: new AbortController().signal,
    formData: async () => formData,
  } as unknown as NextRequest;
}

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

const REINGEST_RESULT = {
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
  fullText: DOC,
  metadata: { format: 'markdown' },
  warnings: [],
};

function setVersion(status: 'draft' | 'launched' | 'archived') {
  (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    status,
  });
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
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });
  setVersion('draft');
  (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue(null); // no dedup
  (prisma.appQuestionnaireSection.count as Mock).mockResolvedValue(6);
  (prisma.appQuestionSlot.count as Mock).mockResolvedValue(24);
  (prisma.appQuestionnaireExtractionChange.count as Mock).mockResolvedValue(5);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    id: 'agent-1',
    provider: 'openai',
    model: 'gpt-5.4',
    fallbackProviders: [],
  });
  (parseDocument as Mock).mockResolvedValue({ ...PARSED_DOC });
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: structuredClone(COHERENT_EXTRACTION),
  });
  (reingestVersion as Mock).mockResolvedValue(REINGEST_RESULT);
  // Default: eligible (so the pre-check the route runs before announcing "checking…" doesn't
  // itself suppress the phase), but the check finds nothing — keeps every pre-existing test's
  // frame sequence and done-event shape (no `adaptiveScopeCandidate` key) unchanged.
  (isEligibleForScopeCandidacy as Mock).mockResolvedValue(true);
  (checkAdaptiveScopeCandidacy as Mock).mockResolvedValue(null);
  (proposeScopeDuringIngest as Mock).mockResolvedValue(null);
});

// ─── Gates (pre-stream — JSON envelope, not SSE) ───────────────────────────────

describe('POST …/reingest/stream — gates', () => {
  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(401);
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(403);
    expect(reingestVersion).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-admin ingest sub-cap is exceeded, before any stream opens', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('returns 404 as JSON when the version does not resolve under the questionnaire', async () => {
    (prisma.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it.each(['launched', 'archived'] as const)(
    'returns 409 REINGEST_NOT_DRAFT as JSON for a %s version (no parse, no dispatch, no write)',
    async (status) => {
      setVersion(status);

      const res = await POST(makeRequest('form.md'), ctx(PARAMS));

      expect(res.status).toBe(409);
      expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
      expect((await res.json()).error.code).toBe('REINGEST_NOT_DRAFT');
      expect(parseDocument).not.toHaveBeenCalled();
      expect(reingestVersion).not.toHaveBeenCalled();
    }
  );

  it('returns 400 as JSON when the file field is missing', async () => {
    const res = await POST(makeRequest(null), ctx(PARAMS));

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    expect((await res.json()).success).toBe(false);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Happy path (SSE) ─────────────────────────────────────────────────────────

describe('POST …/reingest/stream — happy path', () => {
  it('streams real phase frames then a terminal done frame with the replaced counts', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await drainSse(res);
    const types = frames.map((f) => f.type);

    // Progress precedes the terminal frame — the admin sees the work, not a spinner.
    expect(types).toContain('phase');
    expect(types).not.toContain('error');
    expect(types[types.length - 1]).toBe('done');
    // The extract phase is the first thing reported (where the question count arrives).
    const firstPhase = frames.find((f) => f.type === 'phase');
    expect(firstPhase?.data.phase).toBe('extracting');

    expect(frames[frames.length - 1].data).toEqual({
      type: 'done',
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 1,
      questionCount: 1,
      changeCount: 1,
      deduped: false,
    });
  });

  it('replaces the draft in place via reingestVersion with the parsed source provenance', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    await drainSse(res); // drive the generator to completion

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'app_extract_questionnaire_structure',
      expect.objectContaining({ documentText: PARSED_DOC.fullText, fileName: 'onboarding.md' }),
      expect.objectContaining({ userId: ADMIN_ID, agentId: 'agent-1' })
    );
    expect(reingestVersion).toHaveBeenCalledTimes(1);
    expect(reingestVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'ver-1',
        extraction: expect.objectContaining({ inferredGoal: 'Collect details' }),
        source: expect.objectContaining({
          fileName: 'onboarding.md',
          fileHash: hashOf(DOC),
          extractedText: PARSED_DOC.fullText,
        }),
      })
    );
  });

  it('writes an admin audit row tagged mode: stream with the re-ingest counts', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    await drainSse(res);

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'questionnaire.reingest',
        entityType: 'questionnaire_version',
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

  it('records the fidelity critic run against the version it describes', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    await drainSse(res);

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'version',
        subjectId: 'ver-1',
        versionId: 'ver-1',
        kind: 'extraction_verify',
        triggeredByUserId: ADMIN_ID,
      })
    );
  });
});

// ─── Version-scoped dedup no-op ────────────────────────────────────────────────

describe('POST …/reingest/stream — dedup short-circuit', () => {
  it('emits done { deduped: true } with the unchanged counts and does no extraction or write', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      fileHash: hashOf(DOC),
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    expect(frames).toHaveLength(1);
    expect(frames[0].data).toEqual({
      type: 'done',
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 6,
      questionCount: 24,
      changeCount: 5,
      deduped: true,
    });
    expect(parseDocument).not.toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(reingestVersion).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('re-extracts identical bytes when the admin supplied a goal override (never silently dropped)', async () => {
    (prisma.appQuestionnaireSourceDocument.findFirst as Mock).mockResolvedValue({
      fileHash: hashOf(DOC),
    });

    const res = await POST(
      makeRequest('form.md', DOC, 'text/markdown', { goal: 'Refresh structure' }),
      ctx(PARAMS)
    );
    const frames = await drainSse(res);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalled();
    expect(reingestVersion).toHaveBeenCalledWith(
      expect.objectContaining({ admin: expect.objectContaining({ goal: 'Refresh structure' }) })
    );
    expect(frames[frames.length - 1].data).toMatchObject({ type: 'done', deduped: false });
  });
});

// ─── Mid-stream failures (HTTP 200 — the stream already opened) ────────────────

describe('POST …/reingest/stream — mid-stream failures', () => {
  it('emits a terminal error frame when the extractor dispatch fails, and writes nothing', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'rate_limited', message: 'Extractor is rate limited' },
    });

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    // The dispatcher's `rate_limited` is translated on the way out — 429 → `EXTRACTOR_RATE_LIMITED`
    // (`dispatchErrorCode` in `extract-pipeline.ts`). Asserting the code, not just that *an* error
    // frame exists, is what pins that translation: a regression collapsing every dispatch failure
    // to the generic `EXTRACTION_FAILED` would otherwise land green here.
    expect(frames[frames.length - 1].data).toMatchObject({
      type: 'error',
      code: 'EXTRACTOR_RATE_LIMITED',
    });
    expect(frames.some((f) => f.type === 'done')).toBe(false);
    expect(reingestVersion).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('surfaces the writer TOCTOU (launched mid-extraction) as a REINGEST_NOT_DRAFT error frame', async () => {
    // Outer check passed (draft), but the version is launched by the time the writer's
    // transaction re-asserts status. The stream is already open, so it can't be a 409.
    (reingestVersion as Mock).mockRejectedValue(new ReingestNotDraftError('launched'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    expect(frames[frames.length - 1].data).toMatchObject({
      type: 'error',
      code: 'REINGEST_NOT_DRAFT',
    });
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('emits a PERSIST_FAILED error frame when the writer throws for any other reason', async () => {
    (reingestVersion as Mock).mockRejectedValue(new Error('db exploded'));

    const res = await POST(makeRequest('form.md'), ctx(PARAMS));

    const frames = await drainSse(res);
    expect(frames[frames.length - 1].data).toMatchObject({
      type: 'error',
      code: 'PERSIST_FAILED',
    });
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

// ─── Adaptive Scope candidacy wiring (P17.19) ───────────────────────────────────
// `checkAdaptiveScopeCandidacy` itself is mocked at the module boundary — its Prisma-branch
// logic is unit-tested in `_lib/scope-candidacy.test.ts`. These tests only prove this route
// wires the result into its own `checking_scope` phase frame and terminal `done` frame,
// scoped to the non-deduped success path — the deduped short-circuit returns before the
// candidacy check ever runs, so it needs no coverage here (see the dedup describe block above).

describe('POST …/reingest/stream — adaptive scope candidacy wiring', () => {
  it('emits a checking_scope phase frame before the terminal done frame', async () => {
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const phaseNames = frames.filter((f) => f.type === 'phase').map((f) => f.data.phase);
    expect(phaseNames).toContain('checking_scope');
    expect(frames[frames.length - 1].type).toBe('done');
  });

  it('carries adaptiveScopeCandidate on the done frame when the check resolves a verdict', async () => {
    const verdict = { isCandidate: true, confidence: 0.8, summary: 'Has conditional branches.' };
    (checkAdaptiveScopeCandidacy as Mock).mockResolvedValue(verdict);

    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect(doneFrame.data.adaptiveScopeCandidate).toEqual(verdict);
  });

  it('omits adaptiveScopeCandidate from the done frame when the check resolves null', async () => {
    // beforeEach already defaults the mock to null — pins the omission (not
    // present-and-undefined) directly against the parsed SSE frame data.
    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect('adaptiveScopeCandidate' in doneFrame.data).toBe(false);
  });

  it('does not announce a checking_scope phase when the version is pre-check ineligible', async () => {
    // A re-ingest, unlike a fresh ingest, may land on a version that already has scope on or
    // authored topics. Announcing "checking…" for a version the route already knows is
    // ineligible would read as "checked, found nothing" rather than "not applicable" — the route
    // pre-checks and skips the phase (and the check itself) entirely in that case.
    (isEligibleForScopeCandidacy as Mock).mockResolvedValue(false);

    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const phaseNames = frames.filter((f) => f.type === 'phase').map((f) => f.data.phase);
    expect(phaseNames).not.toContain('checking_scope');
    expect(checkAdaptiveScopeCandidacy).not.toHaveBeenCalled();
    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect('adaptiveScopeCandidate' in doneFrame.data).toBe(false);
  });
});

// ─── Proposing during the re-upload (F17.22 Phase 2) ─────────────────────────────

describe('POST …/reingest/stream — proposing scope during the upload', () => {
  const CANDIDATE = { isCandidate: true, confidence: 0.8, summary: 'Has conditional branches.' };

  it('runs the analyst after the check says yes, and reports what it proposed', async () => {
    (checkAdaptiveScopeCandidacy as Mock).mockResolvedValue(CANDIDATE);
    (proposeScopeDuringIngest as Mock).mockResolvedValue({ topicCount: 4, conditionalCount: 2 });

    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const phaseNames = frames.filter((f) => f.type === 'phase').map((f) => f.data.phase);
    expect(phaseNames.indexOf('proposing_scope')).toBeGreaterThan(
      phaseNames.indexOf('checking_scope')
    );
    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.data.adaptiveScopeProposal).toEqual({ topicCount: 4, conditionalCount: 2 });
  });

  it('never runs the analyst when the version was pre-check ineligible', async () => {
    // A re-ingest can land on a version that already has authored topics or a pending draft.
    // Proposing over it would replace work the admin is part-way through reviewing.
    (isEligibleForScopeCandidacy as Mock).mockResolvedValue(false);

    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    await drainSse(res);

    expect(proposeScopeDuringIngest).not.toHaveBeenCalled();
  });

  it('skips the proposal when the re-ingest has already spent the wall-clock budget', async () => {
    (checkAdaptiveScopeCandidacy as Mock).mockResolvedValue(CANDIDATE);
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => ticks++ * 90_000;

    try {
      const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
      const frames = await drainSse(res);

      expect(proposeScopeDuringIngest).not.toHaveBeenCalled();
      expect(frames[frames.length - 1].type).toBe('done');
    } finally {
      Date.now = realNow;
    }
  });

  it('completes the re-ingest when the proposal fails', async () => {
    (checkAdaptiveScopeCandidacy as Mock).mockResolvedValue(CANDIDATE);
    (proposeScopeDuringIngest as Mock).mockResolvedValue(null);

    const res = await POST(makeRequest('onboarding.md'), ctx(PARAMS));
    const frames = await drainSse(res);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame.type).toBe('done');
    expect('adaptiveScopeProposal' in doneFrame.data).toBe(false);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});
