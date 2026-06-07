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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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

  it('resolves to the winning row when a concurrent create hits the partial-unique P2002', async () => {
    // Race: findFirst sees nothing, but another request creates the version's preview
    // session before our create lands → the partial unique index rejects ours with
    // P2002. We must re-read and return the winner, not throw or double-create.
    (prismaMock.appQuestionnaireSession.findFirst as Mock)
      .mockResolvedValueOnce(null) // initial lookup misses
      .mockResolvedValueOnce({ id: 'sess-winner' }); // post-conflict re-read finds the winner
    (prismaMock.appQuestionnaireSession.create as Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    const id = await getOrCreatePreviewSession('v1');

    expect(id).toBe('sess-winner');
    expect(prismaMock.appQuestionnaireSession.findFirst).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-P2002 create error', async () => {
    (prismaMock.appQuestionnaireSession.findFirst as Mock).mockResolvedValue(null);
    (prismaMock.appQuestionnaireSession.create as Mock).mockRejectedValueOnce(
      new Error('connection reset')
    );

    await expect(getOrCreatePreviewSession('v1')).rejects.toThrow('connection reset');
  });
});

// markSessionCompleted moved to the F4.6 session seam (`_lib/sessions.ts`), where it
// now routes through transitionSession + writes a `completed` event — covered in
// session-state-machine.test.ts. answer-slots.ts re-exports it for the /complete route.

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
    // create carries value/provenance; update carries them too.
    expect(arg.update).toMatchObject({ value: 'an answer', provenanceLabel: 'direct' });
  });

  it('initialises refinementHistory on CREATE but never resets it on UPDATE', async () => {
    (prismaMock.appAnswerSlot.upsert as Mock).mockResolvedValue({ id: 'ans-2' });

    await upsertAnswerSlot('sess-1', 'slot-2', { value: 5, provenance: 'inferred' });

    const arg = (prismaMock.appAnswerSlot.upsert as Mock).mock.calls[0]?.[0];
    // CREATE seeds the history (default []) and null optionals.
    expect(arg.create.refinementHistory).toEqual([]);
    expect(arg.create.rationale).toBeNull();
    expect(arg.create.confidence).toBeNull();
    // UPDATE must NOT touch refinementHistory — refinements own it, so re-seeding an
    // already-refined answer can't wipe the accumulated audit trail.
    expect(arg.update).not.toHaveProperty('refinementHistory');
  });

  it('seeds a caller-supplied prior history on create', async () => {
    (prismaMock.appAnswerSlot.upsert as Mock).mockResolvedValue({ id: 'ans-3' });
    const prior = [
      {
        previousValue: 'a',
        previousProvenance: 'direct' as const,
        newValue: 'b',
        rationale: 'r',
        source: 'clarification' as const,
      },
    ];

    await upsertAnswerSlot('sess-1', 'slot-3', {
      value: 'b',
      provenance: 'refined',
      refinementHistory: prior,
    });

    const arg = (prismaMock.appAnswerSlot.upsert as Mock).mock.calls[0]?.[0];
    expect(arg.create.refinementHistory).toEqual(prior);
    expect(arg.update).not.toHaveProperty('refinementHistory');
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
  // Pin the clock so the boundary-stamped createdAt is deterministic and can be
  // asserted by exact value (persistRefinement uses new Date().toISOString()).
  const STAMP = '2026-06-05T12:00:00.000Z';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STAMP));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the new value and provenance, and stamps createdAt on a new history entry', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'age',
      value: 34,
      provenance: 'refined',
      confidence: 0.92,
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
    // A refinement updates the slot's confidence (improving a low capture is the point).
    expect(arg.data.confidence).toBe(0.92);
    expect(arg.data.refinementHistory).toHaveLength(1);
    // The unstamped entry is stamped with the (pinned) boundary clock.
    expect(arg.data.refinementHistory[0].createdAt).toBe(STAMP);
  });

  it('preserves an already-stamped createdAt on a prior entry, stamping only the new one', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'age',
      value: 40,
      provenance: 'refined',
      confidence: 0.88,
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
    expect(history[1].createdAt).toBe(STAMP); // newly stamped with the pinned clock
  });

  it('writes an overwrite that kept its original provenance verbatim', async () => {
    (prismaMock.appAnswerSlot.update as Mock).mockResolvedValue({});

    const refined: RefinedSlotState = {
      slotKey: 'name',
      value: 'corrected',
      provenance: 'direct', // overwrite kept the original label upstream
      confidence: 0.95,
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
