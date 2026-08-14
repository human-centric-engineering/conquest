/**
 * Unit test: the respondent-amendment trigger (P17.6) DB seam (`amend-plan.ts`).
 *
 * `maybeAmendPlan` is fail-soft by contract — never throws, and every failure must leave the
 * stored plan untouched. This file protects that contract plus the wiring around it: the skip
 * gates that run before any query, the free label-match tier, the concurrent-write guard, and
 * `resolveWithAgent`'s failure modes (missing agent, provider resolution, invalid JSON after
 * retry, a hallucinated topic key). The pure amendment logic itself — cue detection, label
 * matching, `applyAmendment` — is unit-tested in `lib/app/questionnaire/scope/amendment.ts`'s own
 * suite and is left REAL here, so these tests prove the wiring around it, not a re-implementation
 * of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  recordAiRun: vi.fn(async () => 'run-1'),
  resolveAgentProviderAndModel: vi.fn(),
  getProvider: vi.fn(),
  logCost: vi.fn(async () => undefined),
  runStructuredCompletion: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: mocks.recordAiRun }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: mocks.resolveAgentProviderAndModel,
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: mocks.getProvider }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: mocks.logCost }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: mocks.runStructuredCompletion,
}));

import { maybeAmendPlan } from '@/app/api/v1/app/questionnaire-sessions/_lib/amend-plan';

const SESSION_ID = 's1';

type TopicRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  phase: string;
  criteria: string | null;
  depth: string;
  members: { dataSlotKeys: string[]; questionKeys: string[] };
  ordinal: number;
  source: string;
};

/** A conditional-phase topic row, the only kind an amendment can ever add. */
function topicRow(key: string, label: string): TopicRow {
  return {
    id: `id-${key}`,
    key,
    label,
    description: null,
    phase: 'conditional',
    criteria: null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [`${key}-q1`] },
    ordinal: 0,
    source: 'seeded',
  };
}

/** A raw stored plan the trigger reads back via `narrowInterviewPlan`. */
function rawPlan(excludedKeys: string[]) {
  return {
    v: 1,
    topics: [],
    excluded: excludedKeys.map((key) => ({ key, source: 'llm', rationale: 'not selected' })),
    checkTopicKey: null,
    confidence: 0.8,
    source: 'llm',
    respondentMessage: '',
    decidedAtTurn: 1,
    decidedAt: '2026-08-01T00:00:00.000Z',
  };
}

function session(over: { interviewPlan?: unknown; adaptiveScope?: Record<string, unknown> } = {}) {
  return {
    versionId: 'v1',
    interviewPlan: 'interviewPlan' in over ? over.interviewPlan : rawPlan(['talent']),
    version: {
      goal: 'grow the pipeline',
      config: {
        adaptiveScope: { enabled: true, allowRespondentAmendment: true, ...over.adaptiveScope },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
  mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([]);
  mocks.recordAiRun.mockResolvedValue('run-1');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('maybeAmendPlan — skip gates before any resolution', () => {
  it('skips before querying anything when the message has no request cue', async () => {
    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: "That's about right, thanks.",
      atTurn: 3,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no request cue' });
    expect(mocks.prisma.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('skips when the session cannot be found', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(null);

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 3,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'session not found' });
  });

  it('skips when adaptive scope is off, without querying the version topics', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ adaptiveScope: { enabled: false } })
    );

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 3,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'adaptive scope is off' });
    expect(mocks.prisma.appQuestionnaireTopic.findMany).not.toHaveBeenCalled();
  });

  it('skips when the version disallows respondent amendment', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ adaptiveScope: { allowRespondentAmendment: false } })
    );

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 3,
    });

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'amendment is not allowed on this version',
    });
  });

  it('skips when there is no plan yet', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ interviewPlan: null })
    );

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 3,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no plan yet' });
  });

  it('skips when nothing is left excluded to add', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ interviewPlan: rawPlan([]) })
    );
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([]);

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 3,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'nothing excluded to add' });
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('maybeAmendPlan — label-match resolution (tier 2, no model call)', () => {
  it('resolves the request by label alone and writes the amended plan', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session());
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([topicRow('talent', 'Talent')]);

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 5,
    });

    const expectedAmendment = {
      key: 'talent',
      label: 'Talent',
      request: 'Can we also cover talent?',
      atTurn: 5,
      at: '2026-08-13T12:00:00.000Z',
    };
    expect(result).toEqual({ kind: 'amended', amendment: expectedAmendment });

    // The free tier resolved it — no model call at all.
    expect(mocks.resolveAgentProviderAndModel).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.runStructuredCompletion).not.toHaveBeenCalled();

    // The actual write: the topic moved from `excluded` to `topics`, and the amendment is recorded.
    expect(mocks.prisma.appQuestionnaireSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, interviewPlan: { not: Prisma.DbNull } },
      data: {
        interviewPlan: {
          v: 1,
          topics: [
            {
              key: 'talent',
              depth: 'full',
              source: 'respondent',
              rationale: 'The respondent asked for this: "Can we also cover talent?"',
            },
          ],
          excluded: [],
          checkTopicKey: null,
          confidence: 0.8,
          source: 'llm',
          respondentMessage: '',
          decidedAtTurn: 1,
          decidedAt: '2026-08-01T00:00:00.000Z',
          amendments: [expectedAmendment],
        },
      },
    });

    expect(mocks.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKind: 'session',
        subjectId: SESSION_ID,
        kind: 'scope_plan',
        status: 'succeeded',
        provider: 'deterministic',
        model: 'deterministic',
        costUsd: 0,
        detail: expect.objectContaining({
          source: 'respondent',
          amendment: true,
          resolvedBy: 'label',
          topicKey: 'talent',
          atTurn: 5,
          candidateKeys: ['talent'],
        }),
      })
    );
  });
});

describe('maybeAmendPlan — the concurrent-write guard', () => {
  it('leaves the plan unchanged when another writer already updated it', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(session());
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([topicRow('talent', 'Talent')]);
    mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: 'Can we also cover talent?',
      atTurn: 5,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'plan disappeared mid-amendment' });
    // The write was attempted exactly once (guarded on the plan still being the one read)...
    expect(mocks.prisma.appQuestionnaireSession.updateMany).toHaveBeenCalledTimes(1);
    // ...but matched zero rows, so no provenance is recorded for an amendment that never landed.
    expect(mocks.recordAiRun).not.toHaveBeenCalled();
  });
});

describe('maybeAmendPlan — fail-soft: never throws', () => {
  it('resolves (does not throw) and leaves the plan unchanged when a dependency rejects', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockRejectedValue(
      new Error('connection reset')
    );

    await expect(
      maybeAmendPlan({
        sessionId: SESSION_ID,
        message: 'Can we also cover talent?',
        atTurn: 5,
      })
    ).resolves.toEqual({ kind: 'skipped', reason: 'amendment failed' });

    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'adaptive scope: amendment failed; the plan is unchanged',
      expect.objectContaining({ sessionId: SESSION_ID, error: 'connection reset' })
    );
  });
});

describe('maybeAmendPlan — resolveWithAgent (tier 3, judgement)', () => {
  // "hiring" does not appear in the candidate's label tokens ("people", "capability"), so the free
  // label match fails and every one of these turns falls through to the agent.
  const AGENT_MESSAGE = 'Can we also cover hiring?';
  const CANDIDATE = topicRow('people-capability', 'People & capability');

  beforeEach(() => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ interviewPlan: rawPlan(['people-capability']) })
    );
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue([CANDIDATE]);
  });

  it('resolves via the agent when the label match fails, pricing the amendment at the resolver cost', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: '',
      model: '',
      fallbackProviders: [],
    });
    mocks.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4o-mini',
      fallbacks: [],
    });
    mocks.getProvider.mockResolvedValue({ chat: vi.fn() });
    mocks.runStructuredCompletion.mockResolvedValue({
      value: { topicKey: 'people-capability' },
      tokenUsage: { input: 400, output: 12 },
      costUsd: 0.0021,
    });

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: AGENT_MESSAGE,
      atTurn: 7,
    });

    expect(result.kind).toBe('amended');
    if (result.kind === 'amended') {
      expect(result.amendment).toEqual({
        key: 'people-capability',
        label: 'People & capability',
        request: AGENT_MESSAGE,
        atTurn: 7,
        at: '2026-08-13T12:00:00.000Z',
      });
    }
    expect(mocks.prisma.appQuestionnaireSession.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'resolved-at-runtime',
        model: 'resolved-at-runtime',
        costUsd: 0.0021,
        detail: expect.objectContaining({
          resolvedBy: 'agent',
          topicKey: 'people-capability',
        }),
      })
    );
  });

  it('returns no amendment when the scope planner agent row is missing', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue(null);

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: AGENT_MESSAGE,
      atTurn: 7,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'request did not resolve to a topic' });
    expect(mocks.resolveAgentProviderAndModel).not.toHaveBeenCalled();
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });

  it('returns no amendment when provider/model resolution fails', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: '',
      model: '',
      fallbackProviders: [],
    });
    mocks.resolveAgentProviderAndModel.mockRejectedValue(new Error('no active provider'));

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: AGENT_MESSAGE,
      atTurn: 7,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'request did not resolve to a topic' });
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });

  it('returns no amendment when the completion is still invalid JSON after the retry', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallbackProviders: [],
    });
    mocks.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4o-mini',
      fallbacks: [],
    });
    mocks.getProvider.mockResolvedValue({ chat: vi.fn() });
    mocks.runStructuredCompletion.mockRejectedValue(
      new Error('Amendment resolver returned invalid JSON after one retry')
    );

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: AGENT_MESSAGE,
      atTurn: 7,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'request did not resolve to a topic' });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'scope amendment: resolver call failed; no amendment',
      expect.objectContaining({
        sessionId: SESSION_ID,
        error: 'Amendment resolver returned invalid JSON after one retry',
      })
    );
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a hallucinated topic key rather than writing it', async () => {
    mocks.prisma.aiAgent.findUnique.mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallbackProviders: [],
    });
    mocks.resolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4o-mini',
      fallbacks: [],
    });
    mocks.getProvider.mockResolvedValue({ chat: vi.fn() });
    mocks.runStructuredCompletion.mockResolvedValue({
      value: { topicKey: 'topic-that-does-not-exist' },
      tokenUsage: { input: 300, output: 8 },
      costUsd: 0.0012,
    });

    const result = await maybeAmendPlan({
      sessionId: SESSION_ID,
      message: AGENT_MESSAGE,
      atTurn: 7,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'request did not resolve to a topic' });
    // The plan is never written on a hallucinated key, even though the completion "succeeded".
    expect(mocks.prisma.appQuestionnaireSession.updateMany).not.toHaveBeenCalled();
    expect(mocks.recordAiRun).not.toHaveBeenCalled();
    // Cost is still attributed — the resolver call happened and cost real money, it just didn't match.
    expect(mocks.logCost).toHaveBeenCalled();
  });
});
