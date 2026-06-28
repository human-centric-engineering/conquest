/**
 * Unit tests for data-slot-fills.ts.
 *
 * Mocks prisma at the module boundary. Verifies first-capture CREATE, the field mapping from
 * DataSlotFillInput → the DB write shape, that the row id (not the input data) is returned, and
 * the UPDATE-with-history behaviour: a changed value appends a `refinementHistory` entry capturing
 * the prior state, while an unchanged value leaves the trail alone. Also covers the `changed` flag
 * the caller uses to gate the "recently updated" flash — true on create / material value or
 * provisional change, false for a reworded re-emit, a key-reorder, or a soft confidence nudge.
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
  it('creates the row with the FK fields + write payload and returns the new id (changed)', async () => {
    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect(res).toEqual({ id: 'created-1', changed: true });
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

  it('defaults provisional to false when the fill omits it', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    expect((prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0]?.data?.provisional).toBe(
      false
    );
  });

  it('persists provisional when the fill is parked', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, { ...FILL, provisional: true });
    expect((prismaMock.appDataSlotFill.create as Mock).mock.calls[0]?.[0]?.data?.provisional).toBe(
      true
    );
  });
});

describe('upsertDataSlotFill — update + history', () => {
  it('updates without a new history entry or flash when only the paraphrase is reworded', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: FILL.value, // same captured position
      paraphrase: 'Things went well',
      confidence: 0.92,
      provisional: false,
      refinementHistory: [],
    });

    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      ...FILL,
      paraphrase: 'Things went well (reworded)',
    });

    // Same value + provisional → not a material change, so the caller won't re-flash the slot.
    expect(res).toEqual({ id: 'existing-1', changed: false });
    expect(prismaMock.appDataSlotFill.create).not.toHaveBeenCalled();
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'existing-1' });
    expect(call?.data?.refinementHistory).toEqual([]);
  });

  it('reports changed=false when the value only reorders object keys', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: { age: 25, gender: 'male' },
      paraphrase: 'A 25-year-old male.',
      confidence: 0.9,
      provisional: false,
      refinementHistory: [],
    });

    // Same data, keys re-emitted in a different order — must not read as a change.
    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: { gender: 'male', age: 25 },
      paraphrase: 'A 25-year-old male.',
      confidence: 0.9,
      provenance: 'direct',
    });

    expect(res.changed).toBe(false);
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.refinementHistory).toEqual([]);
  });

  it('reports changed=false for a soft confidence nudge with the same value', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: 'extremely unlikely',
      paraphrase: 'Extremely unlikely to recommend.',
      confidence: 0.9,
      provisional: false,
      refinementHistory: [],
    });

    // Corroboration raises confidence but the captured position is unchanged.
    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: 'extremely unlikely',
      paraphrase: 'Extremely unlikely to recommend.',
      confidence: 0.95,
      provenance: 'direct',
    });

    expect(res.changed).toBe(false);
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    // The higher confidence still lands on the row — we just don't flash for it.
    expect(call?.data?.confidence).toBe(0.95);
    expect(call?.data?.refinementHistory).toEqual([]);
  });

  it('appends the prior state to history when the value changes', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: { age: 25, gender: 'male' },
      paraphrase: 'A 25-year-old male.',
      confidence: 0.9,
      rationale: 'First reading from their intro.',
      provisional: false,
      refinementHistory: [],
    });

    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: { age: 25, gender: 'female' },
      paraphrase: 'A 25-year-old female.',
      confidence: 0.95,
      provenance: 'direct',
    });

    expect(res.changed).toBe(true);
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.refinementHistory).toHaveLength(1);
    expect(call?.data?.refinementHistory[0]).toMatchObject({
      previousValue: { age: 25, gender: 'male' },
      previousParaphrase: 'A 25-year-old male.',
      previousConfidence: 0.9,
      // The prior rationale is snapshotted so the panel's evolution view can show why it changed.
      previousRationale: 'First reading from their intro.',
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
      provisional: true,
      refinementHistory: [],
    });

    // A real answer arrives (provisional omitted → defaults false) — the row's provisional clears.
    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: 'clear answer',
      paraphrase: 'A clear answer.',
      confidence: 0.95,
      provenance: 'direct',
    });

    expect(res.changed).toBe(true);
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.provisional).toBe(false);
  });

  it('reports changed=true when only the provisional state flips (same value)', async () => {
    prismaMock.appDataSlotFill.findUnique.mockResolvedValue({
      id: 'existing-1',
      value: 'parked guess',
      paraphrase: 'A parked guess.',
      confidence: 0.3,
      provisional: true,
      refinementHistory: [],
    });

    // Same captured value, but promoted from provisional → real: a material state change.
    const res = await upsertDataSlotFill(SESSION_ID, SLOT_ID, {
      value: 'parked guess',
      paraphrase: 'A parked guess.',
      confidence: 0.3,
      provenance: 'inferred',
      provisional: false,
    });

    expect(res.changed).toBe(true);
    // Same value → no history revision; only the provisional flip drove `changed`.
    const call = (prismaMock.appDataSlotFill.update as Mock).mock.calls[0]?.[0];
    expect(call?.data?.refinementHistory).toEqual([]);
  });
});
