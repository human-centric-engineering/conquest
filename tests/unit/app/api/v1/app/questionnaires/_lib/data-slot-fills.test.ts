/**
 * Unit tests for data-slot-fills.ts.
 *
 * Mocks prisma at the module boundary. Verifies the upsert key, the field
 * mapping from DataSlotFillInput → the DB write shape, and that the row id
 * (not the input data) is returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appDataSlotFill: {
    upsert: vi.fn(),
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
  prismaMock.appDataSlotFill.upsert.mockResolvedValue({ id: 'fill-row-1' });
});

describe('upsertDataSlotFill', () => {
  it('returns the persisted row id, not the input value', async () => {
    const id = await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    // The function computes the id from the DB row — asserting 'fill-row-1'
    // proves the code reads row.id rather than echoing an input value.
    expect(id).toBe('fill-row-1');
  });

  it('uses the compound unique key (sessionId, dataSlotId) for the where clause', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);

    expect(prismaMock.appDataSlotFill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId_dataSlotId: { sessionId: SESSION_ID, dataSlotId: SLOT_ID } },
      })
    );
  });

  it('includes sessionId and dataSlotId only in the create payload (not update)', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);

    const call = (prismaMock.appDataSlotFill.upsert as Mock).mock.calls[0]?.[0];
    expect(call?.create).toMatchObject({ sessionId: SESSION_ID, dataSlotId: SLOT_ID });
    // update payload must NOT carry the FK fields (they are the unique key).
    expect(call?.update).not.toHaveProperty('sessionId');
    expect(call?.update).not.toHaveProperty('dataSlotId');
  });

  it('maps fill.provenance → provenanceLabel in the write payload', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);

    const call = (prismaMock.appDataSlotFill.upsert as Mock).mock.calls[0]?.[0];
    // The field is renamed provenance → provenanceLabel at the DB boundary.
    expect(call?.create).toMatchObject({ provenanceLabel: 'direct' });
    expect(call?.create).not.toHaveProperty('provenance');
    expect(call?.update).toMatchObject({ provenanceLabel: 'direct' });
  });

  it('passes fill.value through jsonInput (boundary cast)', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);
    // jsonInput is the storage-boundary cast; it must be called with the raw value.
    expect(jsonInput).toHaveBeenCalledWith(FILL.value);
  });

  it('includes paraphrase, confidence, and rationale in both create and update', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);

    const call = (prismaMock.appDataSlotFill.upsert as Mock).mock.calls[0]?.[0];
    const expectedFields = {
      paraphrase: 'Things went well',
      confidence: 0.92,
      rationale: 'User stated it clearly',
    };
    expect(call?.create).toMatchObject(expectedFields);
    expect(call?.update).toMatchObject(expectedFields);
  });

  it('sets rationale to null when the fill omits it', async () => {
    const fillWithoutRationale: DataSlotFillInput = { ...FILL, rationale: undefined };
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, fillWithoutRationale);

    const call = (prismaMock.appDataSlotFill.upsert as Mock).mock.calls[0]?.[0];
    expect(call?.create?.rationale).toBeNull();
    expect(call?.update?.rationale).toBeNull();
  });

  it('selects only { id: true } — no over-fetching', async () => {
    await upsertDataSlotFill(SESSION_ID, SLOT_ID, FILL);

    expect(prismaMock.appDataSlotFill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } })
    );
  });
});
