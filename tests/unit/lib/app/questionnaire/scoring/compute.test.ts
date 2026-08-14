/**
 * Unit test: scoring computation I/O layer (F14.4).
 *
 * Mocks the answer/fill reads and asserts `scoreSessions` maps question answers + data-slot fills to
 * numeric values keyed by ref, scores each session, and omits sessions that produce no scale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyAnswers = vi.fn();
const findManyFills = vi.fn();
const findManySessions = vi.fn();
const findManyTopics = vi.fn();
const findManyQuestionSlots = vi.fn();
const findManyDataSlots = vi.fn();
const upsertScore = vi.fn();
const findManyScores = vi.fn();
const loggerMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appAnswerSlot: { findMany: (...a: unknown[]) => findManyAnswers(...a) },
    appDataSlotFill: { findMany: (...a: unknown[]) => findManyFills(...a) },
    // Adaptive Scope (P17): `scoreSessions` reads each session's plan to separate "not answered"
    // from "never asked". Default returns no sessions, which is the pre-P17 behaviour.
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
    appQuestionnaireTopic: { findMany: (...a: unknown[]) => findManyTopics(...a) },
    appQuestionSlot: { findMany: (...a: unknown[]) => findManyQuestionSlots(...a) },
    appDataSlot: { findMany: (...a: unknown[]) => findManyDataSlots(...a) },
    appRespondentScore: {
      upsert: (...a: unknown[]) => upsertScore(...a),
      findMany: (...a: unknown[]) => findManyScores(...a),
    },
  },
}));

import {
  itemBounds,
  buildScoringInputs,
  scoreSessions,
  recomputeSessionScores,
  type ScoringInputs,
} from '@/lib/app/questionnaire/scoring/compute';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

const schema: ScoringSchemaContent = {
  method: 'mean',
  scales: [{ key: 'open', name: 'Openness' }],
  items: [
    { source: 'question', ref: 'q1', scaleKey: 'open', weight: 1, reverse: false },
    { source: 'dataSlot', ref: 'risk', scaleKey: 'open', weight: 1, reverse: false },
  ],
  bands: [],
};

const inputs: ScoringInputs = {
  bounds: new Map(),
  questionKeyById: new Map([['qs1', 'q1']]),
  dataSlotKeyById: new Map([['ds1', 'risk']]),
};

beforeEach(() => {
  vi.clearAllMocks();
  findManySessions.mockResolvedValue([]);
  findManyTopics.mockResolvedValue([]);
  // Item weights are read once per version alongside the topics: they decide which members a
  // `light`-depth topic contributes, so scope here resolves the same members the interview asked.
  findManyQuestionSlots.mockResolvedValue([]);
  findManyDataSlots.mockResolvedValue([]);
  // No previously-stored scores by default, so a recompute reports nothing as moved.
  findManyScores.mockResolvedValue([]);
});

describe('scoreSessions', () => {
  it('maps question + data-slot values by ref and scores each session', async () => {
    findManyAnswers.mockResolvedValue([
      { sessionId: 's1', questionSlotId: 'qs1', value: 4 },
      { sessionId: 's2', questionSlotId: 'qs1', value: 2 },
    ]);
    findManyFills.mockResolvedValue([{ sessionId: 's1', dataSlotId: 'ds1', value: 5 }]);

    const out = await scoreSessions(schema, ['s1', 's2'], inputs);

    // s1: mean(4,5)=4.5 ; s2: only q1=2 → mean=2
    expect(out.get('s1')?.open.raw).toBe(4.5);
    expect(out.get('s2')?.open.raw).toBe(2);
  });

  it('coerces stringy numbers and ignores non-numeric values', async () => {
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: '3' }]);
    findManyFills.mockResolvedValue([{ sessionId: 's1', dataSlotId: 'ds1', value: 'high' }]);

    const out = await scoreSessions(schema, ['s1'], inputs);
    // q1='3'→3 counts; risk='high' ignored → mean over one item = 3
    expect(out.get('s1')?.open.raw).toBe(3);
  });

  it('omits sessions that produced no scale and short-circuits an itemless schema', async () => {
    findManyAnswers.mockResolvedValue([]);
    findManyFills.mockResolvedValue([]);
    const out = await scoreSessions(schema, ['s1'], inputs);
    expect(out.has('s1')).toBe(false);

    const none = await scoreSessions({ ...schema, items: [] }, ['s1'], inputs);
    expect(none.size).toBe(0);
    expect(findManyAnswers).toHaveBeenCalledTimes(1); // not called for the itemless schema
  });
});

describe('scoreSessions — Adaptive Scope (P17)', () => {
  /** A session on a version that opted in, with a plan covering only the `core_a` topic. */
  function adaptiveSession() {
    findManySessions.mockResolvedValue([
      {
        id: 's1',
        versionId: 'v1',
        interviewPlan: {
          v: 1,
          topics: [{ key: 'chosen', depth: 'full', source: 'llm', rationale: '' }],
          excluded: [{ key: 'skipped', source: 'llm', rationale: '' }],
          checkTopicKey: null,
          confidence: 0.9,
          source: 'llm',
          respondentMessage: '',
          decidedAtTurn: 2,
          decidedAt: '2026-08-12T00:00:00.000Z',
        },
        version: { config: { adaptiveScope: { enabled: true } } },
      },
    ]);
    findManyTopics.mockResolvedValue([
      {
        id: 't1',
        key: 'chosen',
        label: 'Chosen',
        description: null,
        phase: 'conditional',
        criteria: 'x',
        depth: 'full',
        members: { questionKeys: ['q1'], dataSlotKeys: [] },
        ordinal: 0,
        source: 'manual',
      },
      {
        id: 't2',
        key: 'skipped',
        label: 'Skipped',
        description: null,
        phase: 'conditional',
        criteria: 'y',
        depth: 'full',
        members: { questionKeys: [], dataSlotKeys: ['risk'] },
        ordinal: 1,
        source: 'manual',
      },
    ]);
  }

  it('reports how many of a scale’s items the interview actually asked', async () => {
    // The arithmetic is unchanged — an out-of-scope item has no answer either way. What changes is
    // the record: 1 of 2 items was PUT to this respondent, so a band drawn from it is not the same
    // measurement as one drawn from the whole scale.
    adaptiveSession();
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: 4 }]);
    findManyFills.mockResolvedValue([]);

    const out = await scoreSessions(schema, ['s1'], inputs);

    expect(out.get('s1')?.open.raw).toBe(4);
    expect(out.get('s1')?.open.itemCount).toBe(1);
    expect(out.get('s1')?.open.assessedItemCount).toBe(1);
    expect(out.get('s1')?.open.totalItemCount).toBe(2);
  });

  it('counts every item as asked when the version never opted in', async () => {
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: 4 }]);
    findManyFills.mockResolvedValue([]);

    const out = await scoreSessions(schema, ['s1'], inputs);

    // The distinction only exists for an adaptive instrument. Everywhere else, unanswered means
    // unanswered — and reporting a narrowed instrument would be a claim nobody made.
    expect(out.get('s1')?.open.assessedItemCount).toBe(2);
    expect(out.get('s1')?.open.totalItemCount).toBe(2);
  });
});

/**
 * C8 — which questions can supply a ruler at all.
 *
 * `itemBounds` decides whether an item can be reverse-scored and, under `normalise`, whether it can
 * be scored at all. The `matrix` case is the one worth pinning: it carries a shared scale in its
 * config, but a matrix answer is a composite object that never coerces to a number, so returning
 * bounds for it would advertise a capability the engine does not have.
 */
describe('itemBounds (C8)', () => {
  it('reads a likert scale bounds', () => {
    expect(itemBounds('likert', { min: 1, max: 6, minLabel: 'No', maxLabel: 'Yes' })).toEqual({
      min: 1,
      max: 6,
    });
  });

  it('reads a numeric question bounds when the author set both ends', () => {
    expect(itemBounds('numeric', { min: 0, max: 50 })).toEqual({ min: 0, max: 50 });
  });

  it('returns null for a numeric with an open end — there is no ruler to place it on', () => {
    expect(itemBounds('numeric', { min: 0 })).toBeNull();
    expect(itemBounds('numeric', {})).toBeNull();
    expect(itemBounds('numeric', null)).toBeNull();
  });

  it('returns null for a matrix, whose composite answer never reaches the engine', () => {
    expect(
      itemBounds('matrix', { rows: [{ key: 'r1', label: 'Row' }], scale: { min: 1, max: 5 } })
    ).toBeNull();
  });

  it('returns null for the unbounded types', () => {
    expect(itemBounds('free_text', null)).toBeNull();
    expect(itemBounds('boolean', {})).toBeNull();
    expect(itemBounds('single_choice', { choices: [{ value: 'a', label: 'A' }] })).toBeNull();
  });

  it('returns null for a degenerate range rather than a divide-by-zero waiting to happen', () => {
    expect(itemBounds('numeric', { min: 3, max: 3 })).toBeNull();
  });
});

/**
 * `asFiniteNumber` is not exported — the docblock on `itemBounds` says its purpose is to reject a
 * matrix's composite answer value (`{ rowKey: point }`) so a matrix item never scores. Exercised here
 * through `scoreSessions`, the only path that calls it.
 */
describe('scoreSessions — object-valued (matrix composite) answers', () => {
  it('drops an object-valued answer from the session rather than coercing or crashing', async () => {
    findManyAnswers.mockResolvedValue([
      { sessionId: 's1', questionSlotId: 'qs1', value: { rowKey: 3 } },
    ]);
    findManyFills.mockResolvedValue([{ sessionId: 's1', dataSlotId: 'ds1', value: 5 }]);

    const out = await scoreSessions(schema, ['s1'], inputs);

    // The object-valued q1 answer never enters the session's ref→value map, so only risk=5
    // contributes: raw is risk alone, and itemCount is 1 (not 2).
    expect(out.get('s1')?.open.raw).toBe(5);
    expect(out.get('s1')?.open.itemCount).toBe(1);
  });
});

describe('buildScoringInputs', () => {
  it('builds bounds only for question types with a ruler, plus the full id→key maps', async () => {
    findManyQuestionSlots.mockResolvedValue([
      {
        id: 'qs1',
        key: 'q1',
        type: 'likert',
        typeConfig: { min: 1, max: 6, minLabel: 'No', maxLabel: 'Yes' },
      },
      {
        id: 'qs2',
        key: 'q2',
        type: 'single_choice',
        typeConfig: { choices: [{ value: 'a', label: 'A' }] },
      },
    ]);
    findManyDataSlots.mockResolvedValue([{ id: 'ds1', key: 'risk' }]);

    const result = await buildScoringInputs('v1');

    // q1 is a bounded likert → bounds recorded; q2 is single_choice → itemBounds returns null for it.
    expect(result.bounds.get('q1')).toEqual({ min: 1, max: 6 });
    expect(result.bounds.has('q2')).toBe(false);
    expect(result.questionKeyById).toEqual(
      new Map([
        ['qs1', 'q1'],
        ['qs2', 'q2'],
      ])
    );
    expect(result.dataSlotKeyById).toEqual(new Map([['ds1', 'risk']]));
    // The version scope was passed through to both reads.
    expect(findManyQuestionSlots).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v1' } })
    );
    expect(findManyDataSlots).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v1' } })
    );
  });
});

describe('recomputeSessionScores', () => {
  it('upserts one AppRespondentScore row per scored session and returns the count', async () => {
    // Same shape as the "maps question + data-slot values by ref" scoreSessions test: q1=4, risk=5
    // → mean(4,5)=4.5. buildScoringInputs is exercised for real (not mocked away) so the id→key
    // maps it produces are what scoreSessions consumes.
    findManyQuestionSlots.mockResolvedValue([
      { id: 'qs1', key: 'q1', type: 'single_choice', typeConfig: null },
    ]);
    findManyDataSlots.mockResolvedValue([{ id: 'ds1', key: 'risk' }]);
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: 4 }]);
    findManyFills.mockResolvedValue([{ sessionId: 's1', dataSlotId: 'ds1', value: 5 }]);
    upsertScore.mockResolvedValue({});

    const count = await recomputeSessionScores({
      versionId: 'v1',
      schemaId: 'sch1',
      schema,
      sessionIds: ['s1'],
    });

    expect(count).toBe(1);
    // raw = mean(4,5) = 4.5; schema has no bands, so normalised/band stay null; both items counted
    // and (no adaptive-scope session row) both are treated as asked.
    const expectedScores = {
      open: {
        raw: 4.5,
        normalised: null,
        band: null,
        itemCount: 2,
        assessedItemCount: 2,
        totalItemCount: 2,
      },
    };
    expect(upsertScore).toHaveBeenCalledTimes(1);
    expect(upsertScore).toHaveBeenCalledWith({
      where: { sessionId_schemaId: { sessionId: 's1', schemaId: 'sch1' } },
      create: { sessionId: 's1', schemaId: 'sch1', scores: expectedScores },
      update: { scores: expectedScores },
    });
  });

  it('warns, naming the sessions, when a recompute moves an already-stored score', async () => {
    // The audit trail for a recompute that changes a number someone may already have read: any
    // schema save triggers this, so a moved score must never land silently.
    findManyQuestionSlots.mockResolvedValue([
      { id: 'qs1', key: 'q1', type: 'single_choice', typeConfig: null },
    ]);
    findManyDataSlots.mockResolvedValue([{ id: 'ds1', key: 'risk' }]);
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: 4 }]);
    findManyFills.mockResolvedValue([]);
    upsertScore.mockResolvedValue({});
    // Only q1 answered, so raw = mean(4) = 4. Previously stored as 2 for the same scale.
    findManyScores.mockResolvedValue([{ sessionId: 's1', scores: { open: { raw: 2 } } }]);

    await recomputeSessionScores({
      versionId: 'v1',
      schemaId: 'sch1',
      schema,
      sessionIds: ['s1'],
    });

    expect(loggerMock.logger.warn).toHaveBeenCalledWith(
      'scoring: recompute changed already-stored respondent scores',
      expect.objectContaining({
        versionId: 'v1',
        schemaId: 'sch1',
        changedSessionCount: 1,
        sessionIds: ['s1'],
      })
    );
  });

  it('stays quiet when a recompute reproduces the stored score exactly', async () => {
    findManyQuestionSlots.mockResolvedValue([
      { id: 'qs1', key: 'q1', type: 'single_choice', typeConfig: null },
    ]);
    findManyDataSlots.mockResolvedValue([{ id: 'ds1', key: 'risk' }]);
    findManyAnswers.mockResolvedValue([{ sessionId: 's1', questionSlotId: 'qs1', value: 4 }]);
    findManyFills.mockResolvedValue([]);
    upsertScore.mockResolvedValue({});
    findManyScores.mockResolvedValue([{ sessionId: 's1', scores: { open: { raw: 4 } } }]);

    await recomputeSessionScores({
      versionId: 'v1',
      schemaId: 'sch1',
      schema,
      sessionIds: ['s1'],
    });

    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
  });

  it('returns 0 and never upserts when no session produced a scale', async () => {
    findManyQuestionSlots.mockResolvedValue([]);
    findManyDataSlots.mockResolvedValue([]);
    findManyAnswers.mockResolvedValue([]);
    findManyFills.mockResolvedValue([]);

    const count = await recomputeSessionScores({
      versionId: 'v1',
      schemaId: 'sch1',
      schema,
      sessionIds: ['s1'],
    });

    expect(count).toBe(0);
    expect(upsertScore).not.toHaveBeenCalled();
  });
});
