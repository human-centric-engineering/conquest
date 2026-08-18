/**
 * Unit tests for `checkAdaptiveScopeCandidacy` (P17.19) — the ingestion-time fail-soft
 * orchestration seam invoked by all four ingest/reingest routes (streaming and non-streaming).
 *
 * This is the highest-value item in this batch: a prior version of this function had an
 * unguarded `isEligible()`/agent-lookup call that threw and turned a 500 into every ingest
 * route's happy path (caught during `/pre-pr`, fixed before this plan landed). The two
 * "...throws → fail-soft" tests below exist specifically to pin that "never throws" contract
 * so it can't regress silently — they exercise two DISTINCT unguarded call sites, not the same
 * one twice.
 *
 * @see app/api/v1/app/questionnaires/_lib/scope-candidacy.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireConfig: { findUnique: vi.fn() },
    appQuestionnaireTopicDraft: { findUnique: vi.fn() },
    appQuestionnaireTopic: { findFirst: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
    appQuestionnaireVersion: { update: vi.fn(), findUnique: vi.fn() },
    appAiRun: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  checkAdaptiveScopeCandidacy,
  loadAutoTriggerState,
} from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const AGENT = {
  id: 'agent-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  fallbackProviders: [],
};

const VERDICT_RESULT = {
  isCandidate: true,
  confidence: 0.75,
  signals: [{ note: 'Names a routing rule', sourceQuote: 'Only ask Section B if...' }],
  summary: 'The document describes conditional routing.',
};

/**
 * Build a fresh `log` stand-in whose spies stay reachable for assertions. Passed to the function
 * under test as `log as never` (not the real `Logger` class from `@/lib/api/context`) — the
 * function only ever calls `.warn` / `.error` on it, and mocking the full `@/lib/api/context`
 * module would pull in unrelated request-context machinery this unit test has no need to stand up.
 */
function makeLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Default all three eligibility queries to "eligible" (empty/disabled). */
function seedEligible() {
  (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue(null);
  (prisma.appQuestionnaireTopicDraft.findUnique as Mock).mockResolvedValue(null);
  (prisma.appQuestionnaireTopic.findFirst as Mock).mockResolvedValue(null);
}

const BASE_PARAMS = {
  versionId: 'ver-1',
  documentText: 'A short questionnaire document.',
  fileName: 'survey.pdf',
  adminId: 'admin-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  seedEligible();
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    data: { result: VERDICT_RESULT },
  });
  (prisma.appQuestionnaireVersion.update as Mock).mockResolvedValue({ id: 'ver-1' });
  (recordAiRun as Mock).mockResolvedValue('run-1');
  (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(null);
  (prisma.appAiRun.findFirst as Mock).mockResolvedValue(null);
});

// ─── Eligibility gate ───────────────────────────────────────────────────────

describe('checkAdaptiveScopeCandidacy — eligibility gate (ineligible, no dispatch)', () => {
  it('returns null and never dispatches when a topic draft already exists', async () => {
    (prisma.appQuestionnaireTopicDraft.findUnique as Mock).mockResolvedValue({ id: 'draft-1' });
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null and never dispatches when a non-seeded topic already exists', async () => {
    (prisma.appQuestionnaireTopic.findFirst as Mock).mockResolvedValue({ id: 'topic-1' });
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null and never dispatches when Adaptive Scope is already enabled', async () => {
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      adaptiveScope: { enabled: true },
    });
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkAdaptiveScopeCandidacy — eligible', () => {
  it('proceeds to the agent lookup when all three eligibility queries come back empty/disabled', async () => {
    const log = makeLog();

    await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } })
    );
  });

  it('proceeds when a config row exists but Adaptive Scope is disabled on it', async () => {
    // A config row existing is not the same claim as scope having been decided — reachable on the
    // re-ingest routes, where a target version may already carry a config row an admin saved via
    // the Settings tab with Adaptive Scope left off. Only `.enabled` gates eligibility.
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      adaptiveScope: { enabled: false },
    });
    const log = makeLog();

    await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(capabilityDispatcher.dispatch).toHaveBeenCalled();
  });
});

describe('checkAdaptiveScopeCandidacy — regression: unguarded calls must fail soft', () => {
  it('returns null, warns, and never dispatches when the eligibility check throws (Promise.all member rejects)', async () => {
    // This is the regression test for the bug found during /pre-pr gating: an unguarded
    // eligibility read previously turned a 500 into every ingest route's happy path.
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockRejectedValue(new Error('db down'));
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null when the agent lookup throws (a second, distinct unguarded call site)', async () => {
    (prisma.aiAgent.findUnique as Mock).mockRejectedValue(new Error('db down'));
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkAdaptiveScopeCandidacy — agent not seeded', () => {
  it('returns null and never dispatches when the agent row is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkAdaptiveScopeCandidacy — dispatch outcomes', () => {
  it('returns null and records no AppAiRun when dispatch resolves { success: false }', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'no_provider_configured', message: 'no provider' },
    });
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(recordAiRun).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('returns null and records no AppAiRun when the dispatched result fails schema validation', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { isCandidate: 'not-a-boolean' } },
    });
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(recordAiRun).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('returns null (fail-soft, not a rethrow) when the dispatch call itself rejects', async () => {
    (capabilityDispatcher.dispatch as Mock).mockRejectedValue(new Error('provider timed out'));
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('checkAdaptiveScopeCandidacy — happy path', () => {
  it('returns the trimmed verdict, omitting signals from the returned shape', async () => {
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toEqual({
      isCandidate: VERDICT_RESULT.isCandidate,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
    // The trimming is the point — signals (which may carry document quotes) must not surface.
    expect(result).not.toHaveProperty('signals');
  });

  it('records one AppAiRun with kind scope_candidacy, subjectKind version, and the full result as outputSnapshot', async () => {
    const log = makeLog();

    await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(recordAiRun).toHaveBeenCalledTimes(1);
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'scope_candidacy',
        subjectKind: 'version',
        subjectId: 'ver-1',
        versionId: 'ver-1',
        outputSnapshot: VERDICT_RESULT,
      })
    );
  });

  it('caches the full result under adaptiveScopeCandidate on the version', async () => {
    const log = makeLog();

    await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(prisma.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ver-1' },
        data: expect.objectContaining({ adaptiveScopeCandidate: VERDICT_RESULT }),
      })
    );
  });

  it('swallows a version-cache write failure and still returns the trimmed verdict', async () => {
    (prisma.appQuestionnaireVersion.update as Mock).mockRejectedValue(new Error('write conflict'));
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toEqual({
      isCandidate: VERDICT_RESULT.isCandidate,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('skips recordAiRun and the version-cache write when the version became ineligible mid-check', async () => {
    // The version became genuinely authored (scope enabled / analyst draft landed) while the LLM
    // call was in flight — the SAME eligibility queries the pre-check used now report ineligible.
    // The verdict is still returned to this caller (it describes the document, not the version's
    // current authoring state), but nothing durable is written on top of the real authoring effort.
    (prisma.appQuestionnaireConfig.findUnique as Mock)
      .mockResolvedValueOnce(null) // pre-check: eligible
      .mockResolvedValueOnce({ adaptiveScope: { enabled: true } }); // post-check: no longer eligible
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toEqual({
      isCandidate: VERDICT_RESULT.isCandidate,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
    expect(recordAiRun).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('proceeds with the writes when the post-check re-check itself throws', async () => {
    // A transient failure re-confirming eligibility is not evidence of a real conflict — favour
    // recording the verdict a real LLM call just produced over discarding it on a hiccup.
    (prisma.appQuestionnaireConfig.findUnique as Mock)
      .mockResolvedValueOnce(null) // pre-check: eligible
      .mockRejectedValueOnce(new Error('connection reset')); // post-check: throws
    const log = makeLog();

    const result = await checkAdaptiveScopeCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toEqual({
      isCandidate: VERDICT_RESULT.isCandidate,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
    expect(recordAiRun).toHaveBeenCalledTimes(1);
    expect(prisma.appQuestionnaireVersion.update).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('truncates documentText to the cap before dispatching', async () => {
    const longText = 'x'.repeat(25_000);
    const log = makeLog();

    await checkAdaptiveScopeCandidacy({
      ...BASE_PARAMS,
      documentText: longText,
      log: log as never,
    });

    const dispatchArgs = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      documentText: string;
    };
    expect(dispatchArgs.documentText.length).toBe(20_000);
    expect(dispatchArgs.documentText.length).not.toBe(longText.length);
  });
});

// ─── loadAutoTriggerState (F17.19 Phase 3) ─────────────────────────────────

const ELIGIBLE_CURRENT = { hasAuthoredTopic: false, hasDraft: false, enabled: false };

function seedCandidateVersion(overrides: Partial<typeof VERDICT_RESULT> = {}) {
  (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
    adaptiveScopeCandidate: { ...VERDICT_RESULT, ...overrides },
  });
}

describe('loadAutoTriggerState', () => {
  it('returns candidacy: null, pending: false when the version was never checked', async () => {
    (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      adaptiveScopeCandidate: null,
    });

    const result = await loadAutoTriggerState('ver-1', ELIGIBLE_CURRENT);

    expect(result).toEqual({ candidacy: null, pending: false });
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('returns candidacy: null, pending: false when the cached verdict is malformed', async () => {
    (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      adaptiveScopeCandidate: { isCandidate: 'yes' /* not a boolean */ },
    });

    const result = await loadAutoTriggerState('ver-1', ELIGIBLE_CURRENT);

    expect(result).toEqual({ candidacy: null, pending: false });
  });

  it('trims the verdict (drops signals) and reports pending: false when the document was not a candidate', async () => {
    seedCandidateVersion({ isCandidate: false });

    const result = await loadAutoTriggerState('ver-1', ELIGIBLE_CURRENT);

    expect(result).toEqual({
      candidacy: {
        isCandidate: false,
        confidence: VERDICT_RESULT.confidence,
        summary: VERDICT_RESULT.summary,
      },
      pending: false,
    });
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('reports pending: true for a flagged, untouched version with no prior analyst run', async () => {
    seedCandidateVersion();

    const result = await loadAutoTriggerState('ver-1', ELIGIBLE_CURRENT);

    expect(result).toEqual({
      candidacy: {
        isCandidate: VERDICT_RESULT.isCandidate,
        confidence: VERDICT_RESULT.confidence,
        summary: VERDICT_RESULT.summary,
      },
      pending: true,
    });
    expect(prisma.appAiRun.findFirst).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', kind: 'routing_analysis' },
      select: { id: true },
    });
  });

  it.each([
    ['enabled', { ...ELIGIBLE_CURRENT, enabled: true }],
    ['a pending draft', { ...ELIGIBLE_CURRENT, hasDraft: true }],
    ['an already-authored topic', { ...ELIGIBLE_CURRENT, hasAuthoredTopic: true }],
  ])('reports pending: false when the version already has %s', async (_label, current) => {
    seedCandidateVersion();

    const result = await loadAutoTriggerState('ver-1', current);

    expect(result.pending).toBe(false);
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('reports pending: false once a routing_analysis run already exists — surviving a discard', async () => {
    seedCandidateVersion();
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue({ id: 'run-1' });

    const result = await loadAutoTriggerState('ver-1', ELIGIBLE_CURRENT);

    expect(result.pending).toBe(false);
    // The verdict itself is still reported — only the auto-fire is suppressed.
    expect(result.candidacy?.isCandidate).toBe(true);
  });
});
