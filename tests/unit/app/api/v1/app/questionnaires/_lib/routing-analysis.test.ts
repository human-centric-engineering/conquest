/**
 * Unit tests for `_lib/routing-analysis.ts` — the shared Routing Analyst seam (F17.22 Phase 2).
 *
 * What carries the weight here is the `AppAiRun` bookkeeping, not the happy path. That row is the
 * durable "already tried" signal `resolveAutoTriggerPending` reads, so two failure modes matter
 * more than the proposal itself:
 *
 *   1. A failed run that records NOTHING makes the Topics tab re-propose on every visit — a paid
 *      model call per visit, silently.
 *   2. A failed run recorded as `succeeded` disables the automation for the life of the version.
 *
 * The ingest wrapper is tested for the property the upload depends on: it never throws, whatever
 * the analyst does.
 *
 * @see app/api/v1/app/questionnaires/_lib/routing-analysis.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/scope-candidacy', () => ({
  isEligibleForScopeCandidacy: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-draft', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-draft')>();
  return { ...real, buildRoutingAnalysisInput: vi.fn(), saveTopicDraft: vi.fn() };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  canProposeDuringIngest,
  dispatchRoutingAnalysis,
  MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS,
  persistRoutingAnalysis,
  proposeScopeDuringIngest,
} from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  buildRoutingAnalysisInput,
  saveTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { isEligibleForScopeCandidacy } from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';

type Mock = ReturnType<typeof vi.fn>;

const AGENT = { id: 'agent-1', provider: 'openai', model: 'gpt-5.4', fallbackProviders: [] };

const INPUT = {
  goal: 'Understand growth readiness',
  questions: [{ key: 'q1', prompt: 'How is pipeline?' }],
  dataSlots: [],
  existingTopics: [],
  documents: [
    {
      role: 'primary' as const,
      fileName: 'franchise-review.md',
      text: 'Only ask Section 6 of franchise owners.',
    },
  ],
};

/** What the analyst capability returns — one conditional topic, one always-run topic. */
const RESULT = {
  topics: [
    {
      key: 'pipeline',
      label: 'Pipeline',
      phase: 'conditional' as const,
      criteria: 'They named deals stalling.',
      depth: 'full' as const,
      questionKeys: ['q1'],
      dataSlotKeys: [],
      rationale: 'The routing page restricts this to sales-led businesses.',
    },
  ],
  rules: [],
  gaps: [],
  summary: 'Read from the routing page.',
  fromDocument: true,
};

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const BASE = { versionId: 'ver-1', adminId: 'admin-1', agent: AGENT, input: INPUT, startedAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
    success: true,
    // The capability returns the binding it resolved beside the result — the agent row cannot
    // supply it, because the analyst binds to a tier at call time.
    data: { result: RESULT, provider: 'openai', model: 'gpt-5.4' },
  });
  (saveTopicDraft as Mock).mockImplementation((_versionId: string, draft: unknown) => draft);
  (buildRoutingAnalysisInput as Mock).mockResolvedValue(INPUT);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
  (isEligibleForScopeCandidacy as Mock).mockResolvedValue(true);
});

describe('dispatchRoutingAnalysis', () => {
  it('returns the validated result and records nothing yet', async () => {
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({ ...BASE, log: log as never });

    expect(outcome).toMatchObject({ ok: true });
    // The succeeded run belongs to the persist half — recording it here would mark a proposal
    // "already tried" that was never saved.
    expect(recordAiRun).not.toHaveBeenCalled();
  });

  it('records a FAILED run when the dispatch fails', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'no_provider_configured', message: 'No provider' },
    });
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({ ...BASE, log: log as never });

    expect(outcome).toMatchObject({ ok: false, code: 'no_provider_configured' });
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'routing_analysis', status: 'failed' })
    );
  });

  it('records a FAILED run when the capability returns an unusable shape', async () => {
    // Re-validated rather than asserted: a capability that changed shape must fail here, not write
    // a malformed draft the review surface then has to render.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: { topics: 'not-an-array' } },
    });
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({ ...BASE, log: log as never });

    expect(outcome).toMatchObject({ ok: false, code: 'ROUTING_ANALYSIS_INVALID' });
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'routing_analysis', status: 'failed' })
    );
  });

  it('carries the resolved binding out of the dispatch for the caller to record', async () => {
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({ ...BASE, log: log as never });

    expect(outcome).toMatchObject({ ok: true, binding: { provider: 'openai', model: 'gpt-5.4' } });
  });

  it('falls back to the sentinel when the capability reports no binding', async () => {
    // A capability predating the wider data type must not make a provenance write throw — an
    // unreadable binding degrades to 'n/a' rather than propagating undefined into the row.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: RESULT },
    });
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({ ...BASE, log: log as never });

    expect(outcome).toMatchObject({ ok: true, binding: { provider: 'n/a', model: 'n/a' } });
  });

  it('analyses a version with no source document attached', async () => {
    // The analyst is allowed to propose from the questions alone — it reports that as
    // `fromDocument: false` — so the document keys must be omitted rather than sent empty.
    const log = makeLog();

    await dispatchRoutingAnalysis({
      ...BASE,
      input: {
        goal: INPUT.goal,
        questions: INPUT.questions,
        dataSlots: [],
        existingTopics: [],
        documents: [],
      },
      log: log as never,
    });

    const args = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1];
    expect(args).not.toHaveProperty('documents');
  });

  it('sends the instrument and its supporting documents together', async () => {
    // The whole point of F17.29: an instrument delivered as a question bank plus a separate routing
    // memo used to reach the analyst as whichever file was uploaded last.
    const log = makeLog();

    await dispatchRoutingAnalysis({
      ...BASE,
      input: {
        ...INPUT,
        documents: [
          ...INPUT.documents,
          { role: 'supplementary' as const, fileName: 'routing-memo.md', text: 'Owners only.' },
        ],
      },
      log: log as never,
    });

    const args = (capabilityDispatcher.dispatch as Mock).mock.calls[0][1] as {
      documents: { role: string; fileName: string }[];
    };
    expect(args.documents.map((d) => [d.role, d.fileName])).toEqual([
      ['primary', 'franchise-review.md'],
      ['supplementary', 'routing-memo.md'],
    ]);
  });

  it('falls back to a generic code and message when the dispatch reports neither', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({ success: false });
    const log = makeLog();

    const outcome = await dispatchRoutingAnalysis({
      ...BASE,
      agent: { ...AGENT, provider: '', model: '' },
      log: log as never,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'ROUTING_ANALYSIS_FAILED' });
    // Still recorded — the run's EXISTENCE is the durable "already tried" signal the Topics tab
    // reads, independent of which model it would have used. The sentinel is the honest value on a
    // failure path: the dispatch never reached a provider, so no model served this. It reads 'n/a'
    // rather than 'resolved-at-runtime' so a "runs by provider" rollup isn't split across two
    // spellings of the same nothing.
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', provider: 'n/a', model: 'n/a' })
    );
  });

  it('forwards the admin steer only when there is one', async () => {
    const log = makeLog();

    await dispatchRoutingAnalysis({
      ...BASE,
      instructions: 'Rules are in the notes',
      log: log as never,
    });
    expect((capabilityDispatcher.dispatch as Mock).mock.calls[0][1].instructions).toBe(
      'Rules are in the notes'
    );

    vi.clearAllMocks();
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { result: RESULT },
    });
    await dispatchRoutingAnalysis({ ...BASE, log: log as never });
    expect((capabilityDispatcher.dispatch as Mock).mock.calls[0][1]).not.toHaveProperty(
      'instructions'
    );
  });
});

describe('persistRoutingAnalysis', () => {
  const PERSIST = {
    questionnaireId: 'qn-1',
    versionId: 'ver-1',
    adminId: 'admin-1',
    clientIp: '203.0.113.7',
    input: INPUT,
    result: RESULT,
    // What the dispatch reported actually served the call. Persist no longer takes the agent row:
    // its provider/model are empty by design, so recording them wrote a blank provenance row.
    binding: { provider: 'openai', model: 'gpt-5.4' },
    costUsd: 0.0042,
    startedAt: 0,
    trigger: 'admin' as const,
  };

  it('saves the draft, counts what it covered, and records a succeeded run', async () => {
    const log = makeLog();

    const persisted = await persistRoutingAnalysis({ ...PERSIST, log: log as never });

    expect(saveTopicDraft).toHaveBeenCalledWith('ver-1', expect.objectContaining({ v: 1 }));
    expect(persisted.uncoveredQuestionCount).toBe(0);
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'routing_analysis',
        status: 'succeeded',
        detail: expect.objectContaining({ topicCount: 1, conditionalCount: 1, trigger: 'admin' }),
      })
    );
  });

  it('counts the questions the proposal left in no topic', async () => {
    // With scope active a question in no topic can never be asked, and nothing else in the system
    // reports it — so the number is computed here rather than trusted from the model.
    const log = makeLog();

    const persisted = await persistRoutingAnalysis({
      ...PERSIST,
      input: { ...INPUT, questions: [...INPUT.questions, { key: 'q2', prompt: 'And hiring?' }] },
      log: log as never,
    });

    expect(persisted.uncoveredQuestionCount).toBe(1);
  });

  it('carries the rule quotes and the three settings the analyst may propose', async () => {
    // These ride the same proposal an admin reviews and accepts (F17.23), so the projection has to
    // carry them through untouched — a dropped `maxConditionalTopics` silently widens the plan.
    const log = makeLog();

    await persistRoutingAnalysis({
      ...PERSIST,
      result: {
        ...RESULT,
        rules: [
          {
            dataSlotKey: 'headcount',
            operator: 'gt' as const,
            value: '50',
            action: 'include' as const,
            topicKey: 'pipeline',
            rationale: 'Stated on the guardrails tab.',
            sourceQuote: 'Always include Pipeline when headcount is over 50.',
          },
        ],
        maxConditionalTopics: 3,
        fallbackTopicKeys: ['pipeline'],
        checkTopicPreference: ['pipeline'],
      },
      log: log as never,
    });

    const draft = (saveTopicDraft as Mock).mock.calls[0][1];
    expect(draft.rules[0].sourceQuote).toBe('Always include Pipeline when headcount is over 50.');
    expect(draft.maxConditionalTopics).toBe(3);
    expect(draft.fallbackTopicKeys).toEqual(['pipeline']);
    expect(draft.checkTopicPreference).toEqual(['pipeline']);
  });

  it('records the model that actually served the call, not the agent row placeholder', async () => {
    // The analyst agent ships with empty provider/model and binds to the reasoning tier at call
    // time. This used to record the literal 'resolved-at-runtime', so `AppAiRun` could not answer
    // "which model produced this proposal?" — the one question a corpus-run ledger asks first, and
    // the reason the trial run had to join `ai_cost_log` on a timestamp instead.
    const log = makeLog();

    await persistRoutingAnalysis({
      ...PERSIST,
      binding: { provider: 'openai', model: 'gpt-5.4' },
      costUsd: 0.0042,
      input: { ...INPUT, audience: { who: 'Founders' } },
      log: log as never,
    });

    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.4' })
    );
    // The audience travels with the dispatch input, not the run — pinned here because the spread
    // that carries it is the kind of line a refactor drops without any test noticing.
    expect((saveTopicDraft as Mock).mock.calls[0][1].topics).toHaveLength(1);
  });

  it('stamps replacesExisting from the database, never from the model, and keeps the gaps', async () => {
    // `replacesExisting` is what the review card uses to say "this replaces what you have". It is a
    // fact about the version's live topics, so a model that self-reported it would sometimes be
    // wrong about the one thing an admin decides on. A quote-less topic and a quote-less rule ride
    // along here too — the analyst omits `sourceQuote` when it inferred rather than read.
    const log = makeLog();

    await persistRoutingAnalysis({
      ...PERSIST,
      input: { ...INPUT, existingTopics: [{ key: 'pipeline' }] as never },
      result: {
        ...RESULT,
        topics: [{ ...RESULT.topics[0], sourceQuote: undefined }],
        rules: [
          {
            dataSlotKey: 'headcount',
            operator: 'gt' as const,
            value: '50',
            action: 'include' as const,
            topicKey: 'pipeline',
            rationale: 'Inferred from the question set.',
          },
        ],
        gaps: [{ sourceQuote: 'Use judgement elsewhere.', explanation: 'Nothing to test on.' }],
      },
      log: log as never,
    });

    const draft = (saveTopicDraft as Mock).mock.calls[0][1];
    expect(draft.topics[0].replacesExisting).toBe(true);
    expect(draft.topics[0]).not.toHaveProperty('sourceQuote');
    expect(draft.rules[0]).not.toHaveProperty('sourceQuote');
    expect(draft.gaps).toEqual([
      { sourceQuote: 'Use judgement elsewhere.', explanation: 'Nothing to test on.' },
    ]);
  });

  it('audits which trigger asked for the run', async () => {
    const log = makeLog();

    await persistRoutingAnalysis({ ...PERSIST, trigger: 'ingest', log: log as never });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_topics.analyse',
        metadata: expect.objectContaining({ trigger: 'ingest' }),
      })
    );
  });
});

describe('proposeScopeDuringIngest', () => {
  const PARAMS = {
    questionnaireId: 'qn-1',
    versionId: 'ver-1',
    adminId: 'admin-1',
    clientIp: '203.0.113.7',
  };

  it('proposes, saves and reports the counts', async () => {
    const log = makeLog();

    const proposal = await proposeScopeDuringIngest({ ...PARAMS, log: log as never });

    expect(proposal).toEqual({ topicCount: 1, conditionalCount: 1 });
    expect(saveTopicDraft).toHaveBeenCalled();
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        detail: expect.objectContaining({ trigger: 'ingest' }),
      })
    );
  });

  it('returns null when the version has nothing to analyse', async () => {
    (buildRoutingAnalysisInput as Mock).mockResolvedValue(null);
    const log = makeLog();

    expect(await proposeScopeDuringIngest({ ...PARAMS, log: log as never })).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null when the analyst agent was never seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const log = makeLog();

    expect(await proposeScopeDuringIngest({ ...PARAMS, log: log as never })).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns null on a failed run — and still records the failure', async () => {
    // Recording matters: the Topics tab counts failures to decide whether the auto-trigger gets
    // another attempt. A silent failure here would make it retry forever.
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'provider_unavailable', message: 'down' },
    });
    const log = makeLog();

    expect(await proposeScopeDuringIngest({ ...PARAMS, log: log as never })).toBeNull();
    expect(recordAiRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });

  it('forwards the audience when the version describes one', async () => {
    const log = makeLog();
    (buildRoutingAnalysisInput as Mock).mockResolvedValue({
      ...INPUT,
      audience: { who: 'Founders of 10–50 person firms' },
    });

    await proposeScopeDuringIngest({ ...PARAMS, log: log as never });

    expect((capabilityDispatcher.dispatch as Mock).mock.calls[0][1].audience).toEqual({
      who: 'Founders of 10–50 person firms',
    });
  });

  it('survives a rejection that is not an Error', async () => {
    // A provider SDK can reject with a string or a plain object; the fail-soft path must render
    // that into the log rather than throwing on `.message` and taking the upload down with it.
    (capabilityDispatcher.dispatch as Mock).mockRejectedValue('socket hang up');
    const log = makeLog();

    await expect(proposeScopeDuringIngest({ ...PARAMS, log: log as never })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'socket hang up' })
    );
  });

  it('leaves an admin draft alone when the version was authored during the upload', async () => {
    // The candidacy check RETURNS its verdict while SKIPPING persistence when the version stopped
    // being untouched mid-call, so a `true` verdict is not on its own a licence to write. Without
    // this re-check, `saveTopicDraft` upserts over the proposal the admin is part-way reviewing.
    (isEligibleForScopeCandidacy as Mock).mockResolvedValue(false);
    const log = makeLog();

    expect(await proposeScopeDuringIngest({ ...PARAMS, log: log as never })).toBeNull();
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
    expect(saveTopicDraft).not.toHaveBeenCalled();
  });

  it('never throws, whatever the analyst does', async () => {
    // The property the upload depends on: an ingest that completed must not be reported as failed
    // because an optional proposal blew up.
    (capabilityDispatcher.dispatch as Mock).mockRejectedValue(new Error('socket hang up'));
    const log = makeLog();

    await expect(proposeScopeDuringIngest({ ...PARAMS, log: log as never })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('canProposeDuringIngest', () => {
  it('allows a proposal early in the stream and refuses one late', () => {
    // The analyst is bounded at 180s under a 300s `maxDuration`, so a stream that is already 90
    // seconds in cannot finish one. Running it anyway is worse than skipping: the function is
    // killed mid-`proposing_scope`, the stream dies without `done`, and the dialog reports a
    // failed upload for a questionnaire that was persisted minutes earlier.
    expect(canProposeDuringIngest(0)).toBe(true);
    expect(canProposeDuringIngest(MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS - 1)).toBe(true);
    expect(canProposeDuringIngest(MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS)).toBe(false);
    expect(canProposeDuringIngest(240_000)).toBe(false);
  });

  it('leaves room for the analyst inside the route ceiling', () => {
    // Pinned as arithmetic rather than a magic number: the budget only works while the threshold
    // plus the analyst's own bound stay under `maxDuration`.
    const ANALYST_TIMEOUT_MS = 180_000;
    const ROUTE_MAX_DURATION_MS = 300_000;
    expect(MAX_INGEST_ELAPSED_BEFORE_PROPOSAL_MS + ANALYST_TIMEOUT_MS).toBeLessThan(
      ROUTE_MAX_DURATION_MS
    );
  });
});
