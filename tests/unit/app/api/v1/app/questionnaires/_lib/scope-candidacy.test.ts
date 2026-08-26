/**
 * Unit tests for `checkConditionalTopicsCandidacy` (P17.19) — the ingestion-time fail-soft
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
    appAiRun: { findFirst: vi.fn(), count: vi.fn() },
    appQuestionnaireSection: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));

vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  checkConditionalTopicsCandidacy,
  loadCachedCandidacyVerdict,
  resolveAutoTriggerPending,
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
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    // The capability returns the binding it resolved alongside the verdict — the candidacy agent
    // ships with an empty model and binds to a tier at call time, so this is the only source.
    data: { result: VERDICT_RESULT, provider: 'openai', model: 'gpt-4.1-nano' },
  });
  (prisma.appQuestionnaireVersion.update as Mock).mockResolvedValue({ id: 'ver-1' });
  (recordAiRun as Mock).mockResolvedValue('run-1');
  (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(null);
  (prisma.appAiRun.findFirst as Mock).mockResolvedValue(null);
  (prisma.appAiRun.count as Mock).mockResolvedValue(0);
  (prisma.appQuestionnaireSection.findMany as Mock).mockResolvedValue([]);
});

// ─── Eligibility gate ───────────────────────────────────────────────────────

describe('checkConditionalTopicsCandidacy — eligibility gate (ineligible, no dispatch)', () => {
  it('returns null and never dispatches when a topic draft already exists', async () => {
    (prisma.appQuestionnaireTopicDraft.findUnique as Mock).mockResolvedValue({ id: 'draft-1' });
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null and never dispatches when a non-seeded topic already exists', async () => {
    (prisma.appQuestionnaireTopic.findFirst as Mock).mockResolvedValue({ id: 'topic-1' });
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null and never dispatches when Conditional Topics is already enabled', async () => {
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      conditionalTopics: { enabled: true },
    });
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkConditionalTopicsCandidacy — eligible', () => {
  it('proceeds to the agent lookup when all three eligibility queries come back empty/disabled', async () => {
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } })
    );
  });

  it('proceeds when a config row exists but Conditional Topics is disabled on it', async () => {
    // A config row existing is not the same claim as scope having been decided — reachable on the
    // re-ingest routes, where a target version may already carry a config row an admin saved via
    // the Settings tab with Conditional Topics left off. Only `.enabled` gates eligibility.
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      conditionalTopics: { enabled: false },
    });
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(capabilityDispatcher.dispatch).toHaveBeenCalled();
  });
});

describe('checkConditionalTopicsCandidacy — regression: unguarded calls must fail soft', () => {
  it('returns null, warns, and never dispatches when the eligibility check throws (Promise.all member rejects)', async () => {
    // This is the regression test for the bug found during /pre-pr gating: an unguarded
    // eligibility read previously turned a 500 into every ingest route's happy path.
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockRejectedValue(new Error('db down'));
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null when the agent lookup throws (a second, distinct unguarded call site)', async () => {
    (prisma.aiAgent.findUnique as Mock).mockRejectedValue(new Error('db down'));
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkConditionalTopicsCandidacy — agent not seeded', () => {
  it('returns null and never dispatches when the agent row is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe('checkConditionalTopicsCandidacy — dispatch outcomes', () => {
  it('returns null and records no AppAiRun when dispatch resolves { success: false }', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'no_provider_configured', message: 'no provider' },
    });
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

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

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(recordAiRun).not.toHaveBeenCalled();
    expect(prisma.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('returns null (fail-soft, not a rethrow) when the dispatch call itself rejects', async () => {
    (capabilityDispatcher.dispatch as Mock).mockRejectedValue(new Error('provider timed out'));
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('checkConditionalTopicsCandidacy — happy path', () => {
  it('returns the trimmed verdict, omitting signals from the returned shape', async () => {
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

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

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

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

  it('records the model that actually served the check, not the agent row blank', async () => {
    // The candidacy agent's configured provider/model are empty by design. Recording those wrote
    // 'n/a' onto a check that really ran, so the provenance table could not say which model
    // produced a verdict — the first thing a corpus-run ledger needs when a score moves.
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-4.1-nano' })
    );
  });

  it('falls back to the sentinel when the capability returns no binding', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: VERDICT_RESULT },
    });
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'n/a', model: 'n/a' })
    );
  });

  it('caches the full result under conditionalTopicsCandidate on the version', async () => {
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(prisma.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ver-1' },
        data: expect.objectContaining({ conditionalTopicsCandidate: VERDICT_RESULT }),
      })
    );
  });

  it('swallows a version-cache write failure and still returns the trimmed verdict', async () => {
    (prisma.appQuestionnaireVersion.update as Mock).mockRejectedValue(new Error('write conflict'));
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

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
      .mockResolvedValueOnce({ conditionalTopics: { enabled: true } }); // post-check: no longer eligible
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

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

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).toEqual({
      isCandidate: VERDICT_RESULT.isCandidate,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
    expect(recordAiRun).toHaveBeenCalledTimes(1);
    expect(prisma.appQuestionnaireVersion.update).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('composes an excerpt that reaches routing language at the back of a long document', async () => {
    // The Phase 3 fix, at the seam: a head-slice would have stopped 40,000 characters short of the
    // sentence this whole check exists to find.
    const routingPage = 'ROUTING: only ask Section 6 of franchise owners.';
    const log = makeLog();

    await checkConditionalTopicsCandidacy({
      ...BASE_PARAMS,
      documentText: `${'x '.repeat(30_000)}${routingPage}`,
      log: log as never,
    });

    const dispatchArgs = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      documentText: string;
    };
    expect(dispatchArgs.documentText).toContain(routingPage);
    expect(dispatchArgs.documentText.length).toBeLessThanOrEqual(21_000);
  });

  it('sends the extracted structure alongside the text, in document order', async () => {
    // Read THROUGH sections rather than version-wide: `AppQuestionSlot.ordinal` is only globally
    // ordered because ingestion happens to assign it that way, and the prompt tells the model
    // these are in document order.
    (prisma.appQuestionnaireSection.findMany as Mock).mockResolvedValue([
      {
        title: 'Section 6 — franchise owners only',
        questions: [{ prompt: 'Which best describes your organisation?' }],
      },
      { title: '   ', questions: [{ prompt: 'And how many sites?' }] },
    ]);
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    const dispatchArgs = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      sectionTitles?: string[];
      questionPrompts?: string[];
    };
    // Blank titles are dropped rather than sent as empty numbered rows; their questions are not.
    expect(dispatchArgs.sectionTitles).toEqual(['Section 6 — franchise owners only']);
    expect(dispatchArgs.questionPrompts).toEqual([
      'Which best describes your organisation?',
      'And how many sites?',
    ]);
  });

  it('bounds the structure by characters, not just by item count', async () => {
    // Counts alone let 300 long prompts quadruple a prompt that already carries a 20k excerpt —
    // on a 20s check whose timeout fail-softs to NO verdict, landing the failure on exactly the
    // large routing-shaped instruments this is for.
    (prisma.appQuestionnaireSection.findMany as Mock).mockResolvedValue([
      {
        title: 'T'.repeat(400),
        questions: Array.from({ length: 300 }, () => ({ prompt: 'Q'.repeat(600) })),
      },
    ]);
    const log = makeLog();

    await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    const dispatchArgs = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      sectionTitles: string[];
      questionPrompts: string[];
    };
    expect(dispatchArgs.sectionTitles[0].length).toBe(120);
    expect(dispatchArgs.questionPrompts.every((p) => p.length <= 200)).toBe(true);
    const total =
      dispatchArgs.sectionTitles.join('').length + dispatchArgs.questionPrompts.join('').length;
    expect(total).toBeLessThanOrEqual(8_000);
  });

  it('checks on the document text alone when the structure read throws', async () => {
    // Fail-soft, like everything else here: structure is corroborating evidence, and losing it is a
    // reason to check with less rather than not to check.
    (prisma.appQuestionnaireSection.findMany as Mock).mockRejectedValue(new Error('conn reset'));
    const log = makeLog();

    const result = await checkConditionalTopicsCandidacy({ ...BASE_PARAMS, log: log as never });

    expect(result).not.toBeNull();
    const dispatchArgs = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      sectionTitles?: string[];
    };
    expect(dispatchArgs.sectionTitles).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

// ─── loadCachedCandidacyVerdict / resolveAutoTriggerPending (F17.19 Phase 3) ───

const ELIGIBLE_CURRENT = { hasAuthoredTopic: false, hasDraft: false, enabled: false };

function seedCandidateVersion(overrides: Partial<typeof VERDICT_RESULT> = {}) {
  (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
    conditionalTopicsCandidate: { ...VERDICT_RESULT, ...overrides },
  });
}

describe('loadCachedCandidacyVerdict', () => {
  it('returns null when the version was never checked', async () => {
    (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      conditionalTopicsCandidate: null,
    });

    const result = await loadCachedCandidacyVerdict('ver-1');

    expect(result).toBeNull();
  });

  it('returns null when the cached verdict is malformed', async () => {
    (prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      conditionalTopicsCandidate: { isCandidate: 'yes' /* not a boolean */ },
    });

    const result = await loadCachedCandidacyVerdict('ver-1');

    expect(result).toBeNull();
  });

  it('trims the verdict (drops signals)', async () => {
    seedCandidateVersion({ isCandidate: false });

    const result = await loadCachedCandidacyVerdict('ver-1');

    expect(result).toEqual({
      isCandidate: false,
      confidence: VERDICT_RESULT.confidence,
      summary: VERDICT_RESULT.summary,
    });
  });
});

describe('resolveAutoTriggerPending', () => {
  const CANDIDACY = {
    isCandidate: true,
    confidence: VERDICT_RESULT.confidence,
    summary: VERDICT_RESULT.summary,
  };

  it('returns false without querying when there is no candidacy verdict', async () => {
    const result = await resolveAutoTriggerPending('ver-1', null, ELIGIBLE_CURRENT);

    expect(result).toBe(false);
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('returns false without querying when the document was not a candidate', async () => {
    const result = await resolveAutoTriggerPending(
      'ver-1',
      { ...CANDIDACY, isCandidate: false },
      ELIGIBLE_CURRENT
    );

    expect(result).toBe(false);
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('returns true for a flagged, untouched version with no prior analyst run', async () => {
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue(null);

    const result = await resolveAutoTriggerPending('ver-1', CANDIDACY, ELIGIBLE_CURRENT);

    expect(result).toBe(true);
    // Only a SUCCEEDED run is conclusive (F17.22 Phase 3) — the query must say so, or a failed run
    // suppresses the automation for the life of the version.
    expect(prisma.appAiRun.findFirst).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', kind: 'routing_analysis', status: 'succeeded' },
      select: { id: true },
    });
  });

  it.each([
    ['enabled', { ...ELIGIBLE_CURRENT, enabled: true }],
    ['a pending draft', { ...ELIGIBLE_CURRENT, hasDraft: true }],
    ['an already-authored topic', { ...ELIGIBLE_CURRENT, hasAuthoredTopic: true }],
  ])('returns false when the version already has %s', async (_label, current) => {
    const result = await resolveAutoTriggerPending('ver-1', CANDIDACY, current);

    expect(result).toBe(false);
    expect(prisma.appAiRun.findFirst).not.toHaveBeenCalled();
  });

  it('returns false once a routing_analysis run already exists — surviving a discard', async () => {
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue({ id: 'run-1' });

    const result = await resolveAutoTriggerPending('ver-1', CANDIDACY, ELIGIBLE_CURRENT);

    expect(result).toBe(false);
  });

  it('still fires after ONE failed run — a provider blip must not disable the automation', async () => {
    // The F17.22 Phase 3 defect: any prior run counted as "already tried", including one the route
    // itself logged as failed. Nothing on screen said the automation had been switched off.
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue(null);
    (prisma.appAiRun.count as Mock).mockResolvedValue(1);

    expect(await resolveAutoTriggerPending('ver-1', CANDIDACY, ELIGIBLE_CURRENT)).toBe(true);
    expect(prisma.appAiRun.count).toHaveBeenCalledWith({
      where: { versionId: 'ver-1', kind: 'routing_analysis', status: 'failed' },
    });
  });

  it('gives up after two failures — retrying a misconfigured provider is a bill, not a recovery', async () => {
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue(null);
    (prisma.appAiRun.count as Mock).mockResolvedValue(2);

    expect(await resolveAutoTriggerPending('ver-1', CANDIDACY, ELIGIBLE_CURRENT)).toBe(false);
  });

  it('a success outranks any number of failures', async () => {
    (prisma.appAiRun.findFirst as Mock).mockResolvedValue({ id: 'run-1' });
    (prisma.appAiRun.count as Mock).mockResolvedValue(0);

    expect(await resolveAutoTriggerPending('ver-1', CANDIDACY, ELIGIBLE_CURRENT)).toBe(false);
  });
});
