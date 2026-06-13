/**
 * Unit tests for data-slot-fills.ts.
 *
 * Mocks prisma at the module boundary. Verifies first-capture CREATE, the field mapping from
 * DataSlotFillInput → the DB write shape, that the row id (not the input data) is returned, and
 * the UPDATE-with-history behaviour: a changed value appends a `refinementHistory` entry capturing
 * the prior state, while an unchanged value leaves the trail alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appDataSlotFill: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// jsonInput is re-exported from authoring-routes; mock it to identity so we can
// assert the transformed DB write without pulling Prisma.JsonNull semantics in.
vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', () => ({
  jsonInput: vi.fn((v: unknown) => v),
}));

import { upsertDataSlotFill } from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';
import type { DataSlotFillInput } from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Mock = ReturnType<typeof vi.fn>;

const SESSION_ID = 'sess-1';
const SLOT_ID = 'slot-abc';

const FILL: DataSlotFillInput = {
  value: { sentiment: 'positive' },
  paraphrase: 'Things went well',
  confidence: 0.92,
  provenance: 'direct',
  rationale: 'User stated it clearly',
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appDataSlotFill.findUnique.mockResolvedValue(null);
  prismaMock.appDataSlotFill.create.mockResolvedValue({ id: 'created-1' });
  prismaMock.appDataSlotFill.update.mockResolvedValue({ id: 'existing-1' });
});

describe('upsertDataSlotFill — first capture (CREATE)', () => {
  it('creates the row with the FK fields + write payload and returns the new id', async () => {
    const id = await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect(id).toBe('created-1');
    expect(prismaMock.appDataSlotFill.update).not.toHaveBeenCalled();

    const call = (prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({
      sessionId: SESSION_ID,
      dataSlotId: SLOT_ID,
      paraphrase: 'Things went well',
      confidence: 0.92,
      // provenance is renamed at the DB boundary.
      provenanceLabel: 'direct',
      rationale: 'User stated it clearly',
    });
    expect(call?.data).not.toHaveProperty('provenance');
  });

  it('looks the existing row up by the compound unique key', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect(prismaMock.appDataSlotFill.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId_dataSlotId: { sessionId: SESSION_ID, dataSlotId: SLOT_ID } },
      })
    );
  });

  it('passes fill.value through jsonInput (boundary cast)', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect(jsonInput).toHaveBeenCalledWith(FILL.value);
  });

  it('sets rationale to null when the fill omits it', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, { ...FILL, rationale: undefined });
    const call = (prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0];
    expect(call?.data?.rationale).toBeNull();
  });

  it('defaults provisional to false, and persists it when the fill is parked', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect((prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0]?.data?.provisional).toBe(
      false
    );

    vi.clearAllMocks();
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue(null);
    prismaMock.appDataSlotFill.create.mockResolvedValue({ id: 'created-2' });
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, { ...FILL, provisional: true });
    expect((prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0]?.data?.provisional).toBe(
      true
    );
  });
});

describe('upsertDataSlotFill — update + history', () => {
  it('updates without a new history entry when the value is unchanged', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: FILL.value, // same captured position
      paraphrase: 'Things went well',
      confidence: 0.92,
      refinementHistory: [],
    });

    const id = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      ...FILL,
      paraphrase: 'Things went well (reworded)',
    });

    expect(id).toBe('existing-1');
    expect(prismaMock.appDataSlotFill.create).not.toHaveBeenCalled();
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'existing-1' });
    expect(call?.data?.refinementHistory).toEqual([]);
  });

  it('appends the prior state to history when the value changes', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: { age: 25, gender: 'male' },
      paraphrase: 'A 25-year-old male.',
      confidence: 0.9,
      refinementHistory: [],
    });

    await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: { age: 25, gender: 'female' },
      paraphrase: 'A 25-year-old female.',
      confidence: 0.95,
      provenance: 'direct',
    });

    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.refinementHistory).toHaveLength(1);
    expect(call?.data?.refinementHistory[0]).toMatchObject({
      previousValue: { age: 25, gender: 'male' },
      previousParaphrase: 'A 25-year-old male.',
      previousConfidence: 0.9,
    });
    expect(typeof call?.data?.refinementHistory[0].changedAt).toBe('string');
    // The new value/paraphrase still land on the row.
    expect(call?.data).toMatchObject({ paraphrase: 'A 25-year-old female.', confidence: 0.95 });
  });

  it('preserves a prior history entry and appends the next change', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: 'female',
      paraphrase: 'Female.',
      confidence: 0.9,
      refinementHistory: [
        { previousValue: 'male', previousParaphrase: 'Male.', previousConfidence: 0.8 },
      ],
    });

    await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: 'non-binary',
      paraphrase: 'Non-binary.',
      confidence: 0.9,
      provenance: 'direct',
    });

    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.refinementHistory).toHaveLength(2);
    expect(call?.data?.refinementHistory[1]).toMatchObject({ previousValue: 'female' });
  });

  it('clears provisional on a later confident (non-provisional) fill (promotion)', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: 'tentative',
      paraphrase: 'A tentative reading.',
      confidence: 0.2,
      refinementHistory: [],
    });

    // A real answer arrives (provisional omitted → defaults false) — the row's provisional clears.
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: 'clear answer',
      paraphrase: 'A clear answer.',
      confidence: 0.95,
      provenance: 'direct',
    });

    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.provisional).toBe(false);
  });
});
