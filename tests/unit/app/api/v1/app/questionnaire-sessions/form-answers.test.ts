/**
 * Form-mode answer persistence seam (P-presentation) — the edit-vs-fresh + protection crux.
 *
 * The mock "transaction client" stands in for `Prisma.TransactionClient`; the assertions
 * pin exactly what gets written:
 *   - fresh   → create, provenance `direct`, confidence 1, respondentEdited true, no history
 *   - edit    → update, provenance `refined`, one `manual` history entry preserving the prior
 *               value + provenance (the "adjusted an inferred answer" signal), respondentEdited
 *   - re-save → no history append; only flips respondentEdited if it was false
 *   - clear   → deleteMany on the unique pair
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/form-answers.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  recordManualAnswer,
  clearAnswer,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/form-answers';
import type { Prisma } from '@prisma/client';

type Mock = ReturnType<typeof vi.fn>;

function makeClient(existing: unknown) {
  const findUnique = vi.fn().mockResolvedValue(existing);
  const create = vi.fn().mockResolvedValue({ id: 'new-id' });
  const update = vi.fn().mockResolvedValue({ id: 'row-1' });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const client = { appAnswerSlot: { findUnique, create, update, deleteMany } };
  return {
    client: client as unknown as Prisma.TransactionClient,
    findUnique,
    create,
    update,
    deleteMany,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordManualAnswer', () => {
  it('creates a fresh answer as direct, full confidence, respondent-edited, no history', async () => {
    const { client, create, update } = makeClient(null);
    const outcome = await recordManualAnswer(client, 'sess-1', 'slot-1', 'Engineer');

    expect(outcome).toBe('created');
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: 'sess-1',
      questionSlotId: 'slot-1',
      value: 'Engineer',
      provenanceLabel: 'direct',
      confidence: 1,
      respondentEdited: true,
    });
    expect(data.refinementHistory).toEqual([]);
  });

  it('edits an agent-inferred answer: refined + one manual history entry preserving the prior', async () => {
    const { client, update, create } = makeClient({
      id: 'row-1',
      value: 'Manager',
      provenanceLabel: 'inferred',
      refinementHistory: [],
      respondentEdited: false,
    });
    const outcome = await recordManualAnswer(client, 'sess-1', 'slot-1', 'Engineer');

    expect(outcome).toBe('edited');
    expect(create).not.toHaveBeenCalled();
    const data = (update as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      value: 'Engineer',
      provenanceLabel: 'refined',
      confidence: 1,
      respondentEdited: true,
    });
    expect(data.refinementHistory).toHaveLength(1);
    const entry = data.refinementHistory[0];
    // The crux: a manual entry whose previousProvenance is `inferred` records that the
    // respondent ADJUSTED an agent-inferred answer (vs answered fresh = no entry).
    expect(entry).toMatchObject({
      previousValue: 'Manager',
      previousProvenance: 'inferred',
      newValue: 'Engineer',
      source: 'manual',
    });
    expect(typeof entry.createdAt).toBe('string');
  });

  it('appends to (never replaces) an existing history on a second edit', async () => {
    const prior = {
      previousValue: 'Manager',
      previousProvenance: 'inferred',
      newValue: 'Engineer',
      rationale: 'Edited in form view',
      source: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { client, update } = makeClient({
      id: 'row-1',
      value: 'Engineer',
      provenanceLabel: 'refined',
      refinementHistory: [prior],
      respondentEdited: true,
    });
    await recordManualAnswer(client, 'sess-1', 'slot-1', 'Designer');
    const data = (update as Mock).mock.calls[0][0].data;
    expect(data.refinementHistory).toHaveLength(2);
    expect(data.refinementHistory[0]).toEqual(prior);
    expect(data.refinementHistory[1]).toMatchObject({
      previousValue: 'Engineer',
      newValue: 'Designer',
    });
  });

  it('treats a re-save of the same value as unchanged (no history spam)', async () => {
    const { client, update, create } = makeClient({
      id: 'row-1',
      value: 'Engineer',
      provenanceLabel: 'direct',
      refinementHistory: [],
      respondentEdited: true,
    });
    const outcome = await recordManualAnswer(client, 'sess-1', 'slot-1', 'Engineer');
    expect(outcome).toBe('unchanged');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('marks an unchanged re-affirmation respondent-edited when it was not already', async () => {
    const { client, update } = makeClient({
      id: 'row-1',
      value: 'Engineer',
      provenanceLabel: 'inferred',
      refinementHistory: [],
      respondentEdited: false,
    });
    const outcome = await recordManualAnswer(client, 'sess-1', 'slot-1', 'Engineer');
    expect(outcome).toBe('unchanged');
    expect((update as Mock).mock.calls[0][0].data).toEqual({ respondentEdited: true });
  });
});

describe('clearAnswer', () => {
  it('deletes the answer row on the (session, slot) pair', async () => {
    const { client, deleteMany } = makeClient(null);
    await clearAnswer(client, 'sess-1', 'slot-1');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', questionSlotId: 'slot-1' },
    });
  });
});
