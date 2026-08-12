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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appAnswerSlot: { findMany: (...a: unknown[]) => findManyAnswers(...a) },
    appDataSlotFill: { findMany: (...a: unknown[]) => findManyFills(...a) },
    // Adaptive Scope (P17): `scoreSessions` reads each session's plan to separate "not answered"
    // from "never asked". Default returns no sessions, which is the pre-P17 behaviour.
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
    appQuestionnaireTopic: { findMany: (...a: unknown[]) => findManyTopics(...a) },
  },
}));

import { scoreSessions, type ScoringInputs } from '@/lib/app/questionnaire/scoring/compute';
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
