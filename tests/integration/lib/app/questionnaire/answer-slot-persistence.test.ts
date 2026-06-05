/**
 * Integration test: the answer-slot persistence seam (F4.4).
 *
 * The seam (`_lib/answer-slots.ts`) is the DB write path for refinements. Prisma is
 * mocked (the house convention for these suites), so these assertions pin the seam's
 * own logic around the calls: idempotent preview-session reuse, the upsert composite
 * key + payload, the load-side narrowing (provenance enum, history-array parsing),
 * and — the load-bearing bit — that `persistRefinement` stamps `createdAt` on new
 * history entries at the storage boundary while preserving any already-stamped ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findFirst: vi.fn(), create: vi.fn() },
  appAnswerSlot: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  getOrCreatePreviewSession,
  loadAnswerSlot,
  persistRefinement,
  upsertAnswerSlot,
} from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import type { RefinedSlotState } from '@/lib/app/questionnaire/refinement/types';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreatePreviewSession', () => {
  it('reuses the existing preview session for a version (idempotent)', async () => {
    (prismaMock.appQuestionnaireSession.findFirst as Mock).mockResolvedValue({
      id: 'sess-existing',
    });

    const id = await getOrCreatePreviewSession('v1');

    expect(id).toBe('sess-existing');
    expect(prismaMock.appQuestionnaireSession.create).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v1', isPreview: true } })
    );
  });

  it('creates a preview session when none exists', async () => {
    (prismaMock.appQuestionnaireSession.findFirst as Mock).mockResolvedValue(null);
    (prismaMock.appQuestionnaireSession.create as Mock).mockResolvedValue({ id: 'sess-new' });

    const id = await getOrCreatePreviewSession('v1');

    expect(id).toBe('sess-new');
    expect(prismaMock.appQuestionnaireSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { versionId: 'v1', isPreview: true, status: 'active' },
      })
    );
  });
});

describe('upsertAnswerSlot', () => {
  it('upserts on the (sessionId, questionSlotId) composite key and returns the row id', async () => {
    (prismaMock.appAnswerSlot.upsert as Mock).mockResolvedValue({ id: 'ans-1' });

    const id = await upsertAnswerSlot('sess-1', 'slot-1', {
      value: 'an answer',
      provenance: 'direct',
      rationale: 'stated',
      confidence: 0.9,
    });

    expect(id).toBe('ans-1');
    const arg = (prismaMock.appAnswerSlot.upsert as Mock).mock.calls[0]?.[0];
    expect(arg.where).toEqual({
      sessionId_questionSlotId: { sessionId: 'sess-1', questionSlotId: 'slot-1' },
    });
    expect(arg.create).toMatchObject({
      sessionId: 'sess-1',
      questionSlotId: 'slot-1',
      value: 'an answer',
      provenanceLabel: 'direct',
      rationale: 'stated',
      confidence: 0.9,
    });
    // create and update carry the same payload fields.
    expect(arg.update).toMatchObject({ value: 'an answer', provenanceLabel: 'direct' });
  });

  it('defaults a missing refinementHistory to an empty array and null optionals', async () => {
    (prismaMock.appAnswerSlot.upsert as Mock).mockResolvedValue({ id: 'ans-2' });

    await upsertAnswerSlot('sess-1', 'slot-2', { value: 5, provenance: 'inferred' });

    const arg = (prismaMock.appAnswerSlot.upsert as Mock).mock.calls[0]?.[0];
    expect(arg.create.refinementHistory).toEqual([]);
    expect(arg.create.rationale).toBeNull();
    expect(arg.create.confidence).toBeNull();
  });
});

describe('loadAnswerSlot', () => {
  it('returns null when the slot has no answer in the session', async () => {
    (prismaMock.appAnswerSlot.findUnique as Mock).mockResolvedValue(null);
    expect(await loadAnswerSlot('sess-1', 'slot-1')).toBeNull();
  });

  it('shapes a row into an ExistingAnswerView keyed by the slot key', async () => {
    (prismaMock.appAnswerSlot.findUnique as Mock).mockResolvedValue({
      id: 'ans-1',
      questionSlot: { key: 'age' },
      value: 30,
      provenanceLabel: 'inferred',
      rationale: 'derived',
      confidence: 0.7,
      refinementHistory: [],
    });

    const loaded = await loadAnswerSlot('sess-1', 'slot-1');

    expect(loaded?.id).toBe('ans-1');
    expect(loaded?.existing).toMatchObject({
      slotKey: 'age',
      value: 30,
      provenance: 'inferred',
      rationale: 'derived',
      confidence: 0.7,
      refinementHistory: [],
    });
  });

  it('narrows an unknown stored provenanceLabel to direct', async () => {
    (prismaMock.appAnswerSlot.findUnique as Mock).mockResolvedValue({
      id: 'ans-1',
      questionSlot: { key: 'a' },
      value: 'x',
      provenanceLabel: 'bogus',
      rationale: null,
      confidence: null,
      refinementHistory: [],
    });

    const loaded = await loadAnswerSlot('sess-1', 'slot-1');
    expect(loaded?.existing.provenance).toBe('direct');
  });

  it('defaults a non-array refinementHistory column to an empty array', async () => {
    (prismaMock.appAnswerSlot.findUnique as Mock).mockResolvedValue({
      id: 'ans-1',
      questionSlot: { key: 'a' },
      value: 'x',
      provenanceLabel: 'direct',
      rationale: null,
      confidence: null,
      refinementHistory: null,
    });

    const loaded = await loadAnswerSlot('sess-1', 'slot-1');
    expect(loaded?.existing.refinementHistory).toEqual([]);
  });
});

describe('persistRefinement', () => {
  it('writes the new value and provenance, and stamps createdAt on a new history entry', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'age',
      value: 34,
      provenance: 'refined',
      refinementHistory: [
        {
          previousValue: 30,
          previousProvenance: 'direct',
          newValue: 34,
          rationale: 'reconsidered',
          source: 'clarification',
        },
      ],
    };

    await persistRefinement('ans-1', refined);

    const arg = (prismaMock.appAnswerSlot.update as Mock).mock.calls[0]?.[0];
    expect(arg.where).toEqual({ id: 'ans-1' });
    expect(arg.data.value).toBe(34);
    expect(arg.data.provenanceLabel).toBe('refined');
    expect(arg.data.refinementHistory).toHaveLength(1);
    expect(arg.data.refinementHistory[0]).toHaveProperty('createdAt');
    expect(typeof arg.data.refinementHistory[0].createdAt).toBe('string');
  });

  it('preserves an already-stamped createdAt on a prior entry', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'age',
      value: 40,
      provenance: 'refined',
      refinementHistory: [
        {
          previousValue: 30,
          previousProvenance: 'direct',
          newValue: 34,
          rationale: 'first',
          source: 'clarification',
          // already persisted earlier — carries its own timestamp
          createdAt: '2026-01-01T00:00:00.000Z',
        } as never,
        {
          previousValue: 34,
          previousProvenance: 'refined',
          newValue: 40,
          rationale: 'second',
          source: 'clarification',
        },
      ],
    };

    await persistRefinement('ans-1', refined);

    const history = (prismaMock.appAnswerSlot.update as Mock).mock.calls[0]?.[0].data
      .refinementHistory;
    expect(history[0].createdAt).toBe('2026-01-01T00:00:00.000Z'); // untouched
    expect(history[1].createdAt).toBeTypeOf('string'); // newly stamped
    expect(history[1].createdAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes an overwrite that kept its original provenance verbatim', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'name',
      value: 'corrected',
      provenance: 'direct', // overwrite kept the original label upstream
      refinementHistory: [
        {
          previousValue: 'typo',
          previousProvenance: 'direct',
          newValue: 'corrected',
          rationale: 'fix',
          source: 'correction',
        },
      ],
    };

    await persistRefinement('ans-1', refined);
    expect((prismaMock.appAnswerSlot.update as Mock).mock.calls[0]?.[0].data.provenanceLabel).toBe(
      'direct'
    );
  });
});
