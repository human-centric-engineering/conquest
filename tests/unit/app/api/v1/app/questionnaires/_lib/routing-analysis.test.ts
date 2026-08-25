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

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-draft', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-draft')>();
  return { ...real, buildRoutingAnalysisInput: vi.fn(), saveTopicDraft: vi.fn() };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  dispatchRoutingAnalysis,
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

type Mock = ReturnType<typeof vi.fn>;

const AGENT = { id: 'agent-1', provider: 'openai', model: 'gpt-5.4', fallbackProviders: [] };

const INPUT = {
  goal: 'Understand growth readiness',
  questions: [{ key: 'q1', prompt: 'How is pipeline?' }],
  dataSlots: [],
  existingTopics: [],
  documentText: 'Only ask Section 6 of franchise owners.',
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
    data: { result: RESULT },
  });
  (saveTopicDraft as Mock).mockImplementation((_versionId: string, draft: unknown) => draft);
  (buildRoutingAnalysisInput as Mock).mockResolvedValue(INPUT);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue(AGENT);
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
    agent: AGENT,
    input: INPUT,
    result: RESULT,
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

  it('never throws, whatever the analyst does', async () => {
    // The property the upload depends on: an ingest that completed must not be reported as failed
    // because an optional proposal blew up.
    (capabilityDispatcher.dispatch as Mock).mockRejectedValue(new Error('socket hang up'));
    const log = makeLog();

    await expect(proposeScopeDuringIngest({ ...PARAMS, log: log as never })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});
