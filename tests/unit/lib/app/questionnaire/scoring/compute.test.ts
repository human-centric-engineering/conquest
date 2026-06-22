/**
 * Unit test: scoring computation I/O layer (F14.4).
 *
 * Mocks the answer/fill reads and asserts `scoreSessions` maps question answers + data-slot fills to
 * numeric values keyed by ref, scores each session, and omits sessions that produce no scale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyAnswers = vi.fn();
const findManyFills = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appAnswerSlot: { findMany: (...a: unknown[]) => findManyAnswers(...a) },
    appDataSlotFill: { findMany: (...a: unknown[]) => findManyFills(...a) },
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
