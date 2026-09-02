/**
 * Integration test: the early-seating trigger — the WIRING, not the arithmetic.
 *
 * `earlySeatingGate` and `applyEarlyJudgements` are unit-tested beside the pure module. What this
 * file protects is what a unit test cannot see: that the trigger reads the right columns, splits
 * given fills from parked ones before measuring the floor, stands down when the planner is about to
 * seal, guards its write on the session still being unplanned, and stays silent on every ordinary
 * turn. Each of those can be individually correct and still produce a feature that never fires.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    appQuestionSlot: { findMany: vi.fn() },
    appDataSlot: { findMany: vi.fn() },
  },
  judgeEarlySeating: vi.fn(),
  recordAiRun: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: mocks.recordAiRun }));
vi.mock('@/lib/app/questionnaire/scope/early-planner', () => ({
  judgeEarlySeating: mocks.judgeEarlySeating,
}));

import { maybeSeatEarlyTopics } from '@/app/api/v1/app/questionnaire-sessions/_lib/seat-early-topics';
import type { EarlySeating } from '@/lib/app/questionnaire/scope/types';

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

function topicRow(
  key: string,
  phase: string,
  members: Partial<TopicRow['members']> = {}
): TopicRow {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it fits' : null,
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [], ...members },
    ordinal: 0,
    source: 'seeded',
  };
}

/** Settings that let a pass through: on, floor 50%, one seat. */
const ON = {
  enabled: true,
  earlyTopicSeating: true,
  earlySeatingFloor: 0.5,
  earlySeatingMinConfidence: 0.85,
  maxEarlySeatedTopics: 1,
  maxRoutingDecisionsPerTurn: 1,
};

function session(
  over: {
    answers?: string[];
    fills?: string[];
    parkedFills?: string[];
    turns?: number;
    settings?: Record<string, unknown>;
    interviewPlan?: unknown;
    earlySeatedTopics?: unknown;
  } = {}
) {
  return {
    versionId: 'v1',
    interviewPlan: over.interviewPlan ?? null,
    earlySeatedTopics: over.earlySeatedTopics ?? null,
    version: {
      goal: 'find the constraint',
      config: { conditionalTopics: { ...ON, ...over.settings } },
    },
    dataSlotFills: [
      ...(over.fills ?? []).map((key) => ({
        confidence: 0.9,
        value: 'said something',
        paraphrase: null,
        provisional: false,
        provenanceLabel: 'direct',
        dataSlot: { key },
      })),
      ...(over.parkedFills ?? []).map((key) => ({
        confidence: 0.2,
        value: 'best guess',
        paraphrase: null,
        provisional: true,
        provenanceLabel: 'inferred',
        dataSlot: { key },
      })),
    ],
    answers: (over.answers ?? []).map((key) => ({
      value: null,
      paraphrase: `what they said about ${key}`,
      questionSlot: { key, prompt: `the question behind ${key}?` },
    })),
    _count: { turns: over.turns ?? 3 },
  };
}

/** An opening of four members, so coverage moves in 25% steps. */
const TOPICS = [
  topicRow('open', 'opening', {
    questionKeys: ['q1', 'q2'],
    dataSlotKeys: ['situation', 'goals'],
  }),
  topicRow('pipeline', 'conditional', { questionKeys: ['p1'] }),
  topicRow('forecast', 'conditional', { questionKeys: ['f1'] }),
];

function judged(...entries: Array<[string, number]>) {
  return {
    judgements: entries.map(([key, confidence]) => ({
      key,
      confidence,
      rationale: `because ${key}`,
      respondentReason: `you mentioned ${key}`,
    })),
    costUsd: 0.002,
    provider: 'openai',
    model: 'gpt-5.4',
    promptSnapshot: 'the prompt',
    outputSnapshot: { clear: [] },
  };
}

/** The `earlySeatedTopics` value the trigger wrote, as the narrowed shape. */
function written(): EarlySeating {
  const call = mocks.prisma.appQuestionnaireSession.updateMany.mock.calls[0]?.[0] as {
    data: { earlySeatedTopics: EarlySeating };
  };
  return call.data.earlySeatedTopics;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
  mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([
    { key: 'q1' },
    { key: 'q2' },
    { key: 'p1' },
    { key: 'f1' },
  ]);
  mocks.judgeEarlySeating.mockResolvedValue(judged());
});

describe('maybeSeatEarlyTopics — standing down', () => {
  it('costs one read and nothing else when the feature is off', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ settings: { earlyTopicSeating: false } })
    );

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'early seating is off',
    });
    // The topic query is the first real cost, and an opted-out version must never pay it.
    expect(mocks.prisma.appQuestionnaireTopic.findMany).not.toHaveBeenCalled();
    expect(mocks.judgeEarlySeating).not.toHaveBeenCalled();
  });

  it('stands down once a plan exists', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({
        answers: ['q1', 'q2'],
        fills: ['situation', 'goals'],
        interviewPlan: { v: 1, topics: [], excluded: [], confidence: 1, source: 'llm' },
      })
    );

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'already planned',
    });
    expect(mocks.judgeEarlySeating).not.toHaveBeenCalled();
  });

  it('stands down on the turn the opening completes, leaving it to the planner', async () => {
    // Two decisions about one interview on one turn is the thing this ordering exists to prevent.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1', 'q2'], fills: ['situation', 'goals'] })
    );

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'the opening completed this turn',
    });
    expect(mocks.judgeEarlySeating).not.toHaveBeenCalled();
  });

  it('stays below the floor when the only extra coverage is a parked slot', async () => {
    // THE asymmetry this feature turns on. One real answer of four members is 25%, under the 50%
    // floor. A park is not evidence anyone gave, so it must not carry the session over.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1'], parkedFills: ['situation', 'goals'] })
    );

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'below the opening-coverage floor',
    });
    expect(mocks.judgeEarlySeating).not.toHaveBeenCalled();
  });

  it('passes the floor on the same coverage when it was actually answered', async () => {
    // The control for the test above: the same two members, given rather than parked.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      session({ answers: ['q1'], fills: ['situation'] })
    );

    await maybeSeatEarlyTopics('s1');

    expect(mocks.judgeEarlySeating).toHaveBeenCalledTimes(1);
  });
});

describe('maybeSeatEarlyTopics — seating', () => {
  function ready(over: Parameters<typeof session>[0] = {}) {
    return session({ answers: ['q1'], fills: ['situation'], ...over });
  }

  it('seats a confident judgement and reports it', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(ready());
    mocks.judgeEarlySeating.mockResolvedValue(judged(['pipeline', 0.94]));

    const result = await maybeSeatEarlyTopics('s1');

    expect(result.kind).toBe('seated');
    if (result.kind !== 'seated') return;
    expect(result.seated.map((s) => s.key)).toEqual(['pipeline']);
    expect(result.fromDeferred).toBe(false);
    expect(written().seated.map((s) => s.key)).toEqual(['pipeline']);
  });

  it('shows the model only the candidates it may still choose', async () => {
    const early: EarlySeating = {
      v: 1,
      seated: [
        {
          key: 'pipeline',
          depth: 'full',
          confidence: 0.9,
          rationale: '',
          respondentReason: '',
          atTurn: 2,
        },
      ],
      deferred: [],
      lastPassAtTurn: 2,
      evidenceKey: 'stale',
      overCap: false,
    };
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      ready({ earlySeatedTopics: early, settings: { maxEarlySeatedTopics: 2 } })
    );

    await maybeSeatEarlyTopics('s1');

    const params = mocks.judgeEarlySeating.mock.calls[0]?.[0] as {
      candidates: Array<{ key: string }>;
    };
    expect(params.candidates.map((c) => c.key)).toEqual(['forecast']);
  });

  it('writes the pass even when nothing cleared the bar', async () => {
    // The record stamps the evidence key, which is what stops the next turn paying for the same
    // question over the same evidence. A pass that judged nothing is still a pass.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(ready());
    mocks.judgeEarlySeating.mockResolvedValue(judged(['pipeline', 0.4]));

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'nothing was clear enough to seat',
    });
    expect(written().seated).toEqual([]);
    expect(written().evidenceKey).not.toBe('');
  });

  it('drains a deferred pick with no model call', async () => {
    const early: EarlySeating = {
      v: 1,
      seated: [],
      deferred: [
        {
          key: 'forecast',
          depth: 'full',
          confidence: 0.95,
          rationale: 'r',
          respondentReason: 'rr',
          atTurn: 2,
        },
      ],
      lastPassAtTurn: 2,
      evidenceKey: 'stale',
      overCap: true,
    };
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      ready({ earlySeatedTopics: early })
    );

    const result = await maybeSeatEarlyTopics('s1');

    expect(result.kind).toBe('seated');
    if (result.kind !== 'seated') return;
    expect(result.fromDeferred).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(mocks.judgeEarlySeating).not.toHaveBeenCalled();
    expect(written().deferred).toEqual([]);
  });

  it('records an audit row for a real judgement and none for a drain', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(ready());
    mocks.judgeEarlySeating.mockResolvedValue(judged(['pipeline', 0.94]));
    await maybeSeatEarlyTopics('s1');
    expect(mocks.recordAiRun).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
    mocks.prisma.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }, { key: 'q2' }]);
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(
      ready({
        earlySeatedTopics: {
          v: 1,
          seated: [],
          deferred: [
            {
              key: 'forecast',
              depth: 'full',
              confidence: 0.95,
              rationale: 'r',
              respondentReason: 'rr',
              atTurn: 2,
            },
          ],
          lastPassAtTurn: 2,
          evidenceKey: 'stale',
          overCap: true,
        },
      })
    );
    await maybeSeatEarlyTopics('s1');
    // A drained pick is not a judgement. Recording one would put a row in the audit trail that
    // nobody decided anything in.
    expect(mocks.recordAiRun).not.toHaveBeenCalled();
  });

  it('does not seat into a plan that was sealed first', async () => {
    // The `interviewPlan: null` guard in the WHERE. A topic seated into a plan that has already
    // been made and announced would widen an interview whose respondent was just told what it
    // covers.
    mocks.prisma.appQuestionnaireSession.findUnique.mockResolvedValue(ready());
    mocks.judgeEarlySeating.mockResolvedValue(judged(['pipeline', 0.94]));
    mocks.prisma.appQuestionnaireSession.updateMany.mockResolvedValue({ count: 0 });

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'the plan was sealed first',
    });
  });

  it('never throws — a failure leaves the interview deciding at the end as usual', async () => {
    mocks.prisma.appQuestionnaireSession.findUnique.mockRejectedValue(new Error('db is down'));

    expect(await maybeSeatEarlyTopics('s1')).toEqual({
      kind: 'skipped',
      reason: 'early seating failed',
    });
  });
});
