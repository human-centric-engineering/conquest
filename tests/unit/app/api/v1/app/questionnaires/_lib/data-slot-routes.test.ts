/**
 * Unit tests for data-slot-routes.ts.
 *
 * Mocks prisma + executeTransaction at the boundary.  Tests verify the real
 * transformations the module performs: projection via toDataSlotView, Zod
 * re-validation of draft JSON, key generation via slugifyKey/nextAvailableKey,
 * the buildDataSlotStructure scope-guard (mismatched IDs → null, empty questions
 * → null), and the replaceDataSlots transaction shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the prisma mock so we can reference it in vi.mock().
const prismaMock = vi.hoisted(() => ({
  appDataSlot: {
    findMany: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  appDataSlotDraft: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  appDataSlotQuestion: {
    createMany: vi.fn(),
  },
  appQuestionnaireVersion: {
    findFirst: vi.fn(),
  },
  appQuestionSlot: {
    findMany: vi.fn(),
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// executeTransaction: invoke the callback with a tx proxy that mirrors the mock shape.
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: typeof prismaMock) => Promise<unknown>) =>
    cb(prismaMock)
  ),
}));

import {
  toDataSlotView,
  loadDataSlots,
  countDataSlots,
  loadDataSlotDraft,
  upsertDataSlotDraft,
  deleteDataSlotDraft,
  buildDataSlotStructure,
  replaceDataSlots,
  DATA_SLOT_SELECT,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import type { DataSlotInput } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { executeTransaction } from '@/lib/db/utils';

type Mock = ReturnType<typeof vi.fn>;

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeDbRow(
  over: Partial<{
    id: string;
    key: string;
    name: string;
    description: string;
    theme: string;
    ordinal: number;
    weight: number;
    questions: { questionSlot: { key: string } }[];
  }> = {}
) {
  return {
    id: over.id ?? 'slot-1',
    key: over.key ?? 's_key',
    name: over.name ?? 'Slot Name',
    description: over.description ?? 'desc',
    theme: over.theme ?? 'T',
    ordinal: over.ordinal ?? 0,
    weight: over.weight ?? 1,
    questions: over.questions ?? [{ questionSlot: { key: 'q1' } }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── toDataSlotView ────────────────────────────────────────────────────────────

describe('toDataSlotView', () => {
  it('projects a db row to the client-safe DataSlotView shape', () => {
    const row = makeDbRow({
      id: 'x1',
      key: 'k',
      name: 'N',
      description: 'D',
      theme: 'Th',
      ordinal: 3,
      weight: 2,
      questions: [{ questionSlot: { key: 'qa' } }, { questionSlot: { key: 'qb' } }],
    });
    const view = toDataSlotView(row);
    expect(view).toEqual({
      id: 'x1',
      key: 'k',
      name: 'N',
      description: 'D',
      theme: 'Th',
      ordinal: 3,
      weight: 2,
      questionKeys: ['qa', 'qb'],
    });
  });

  it('flattens the nested questionSlot.key into a flat string array', () => {
    const row = makeDbRow({
      questions: [
        { questionSlot: { key: 'q1' } },
        { questionSlot: { key: 'q2' } },
        { questionSlot: { key: 'q3' } },
      ],
    });
    const view = toDataSlotView(row);
    expect(view.questionKeys).toEqual(['q1', 'q2', 'q3']);
    // The nested questionSlot structure must NOT appear on the view.
    expect(view).not.toHaveProperty('questions');
  });

  it('produces an empty questionKeys array when the slot has no question mappings', () => {
    const row = makeDbRow({ questions: [] });
    expect(toDataSlotView(row).questionKeys).toEqual([]);
  });
});

// ── DATA_SLOT_SELECT ─────────────────────────────────────────────────────────

describe('DATA_SLOT_SELECT', () => {
  it('selects id, key, name, description, theme, ordinal, weight, and questions', () => {
    expect(DATA_SLOT_SELECT).toMatchObject({
      id: true,
      key: true,
      name: true,
      description: true,
      theme: true,
      ordinal: true,
      weight: true,
    });
    expect(DATA_SLOT_SELECT.questions).toBeDefined();
  });
});

// ── loadDataSlots ─────────────────────────────────────────────────────────────

describe('loadDataSlots', () => {
  it('queries for the version in ordinal order and maps rows to views', async () => {
    const rows = [
      makeDbRow({ id: 'a', ordinal: 0, key: 'slot_a' }),
      makeDbRow({ id: 'b', ordinal: 1, key: 'slot_b' }),
    ];
    prismaMock.appDataSlot.findMany.mockResolvedValue(rows);

    const views = await loadDataSlots('v-1');

    expect(prismaMock.appDataSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId: 'v-1' },
        orderBy: { ordinal: 'asc' },
      })
    );
    expect(views).toHaveLength(2);
    // Ids come from the DB rows, not the call arguments.
    expect(views.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when the version has no slots', async () => {
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);
    expect(await loadDataSlots('v-empty')).toEqual([]);
  });
});

// ── countDataSlots ────────────────────────────────────────────────────────────

describe('countDataSlots', () => {
  it('delegates to prisma.appDataSlot.count with the versionId and returns the count', async () => {
    prismaMock.appDataSlot.count.mockResolvedValue(5);
    const n = await countDataSlots('v-5');

    expect(prismaMock.appDataSlot.count).toHaveBeenCalledWith({ where: { versionId: 'v-5' } });
    expect(n).toBe(5);
  });

  it('returns 0 when there are no slots', async () => {
    prismaMock.appDataSlot.count.mockResolvedValue(0);
    expect(await countDataSlots('v-empty')).toBe(0);
  });
});

// ── loadDataSlotDraft ─────────────────────────────────────────────────────────

describe('loadDataSlotDraft', () => {
  it('returns null when no draft row exists', async () => {
    prismaMock.appDataSlotDraft.findUnique.mockResolvedValue(null);
    expect(await loadDataSlotDraft('v-1')).toBeNull();
  });

  it('returns null when the stored slots JSON fails the Zod schema (no throw)', async () => {
    prismaMock.appDataSlotDraft.findUnique.mockResolvedValue({
      slots: [{ name: '', description: 'x', theme: 'T', questionKeys: [] }], // invalid: empty name
      updatedAt: new Date('2025-01-01'),
    });
    expect(await loadDataSlotDraft('v-bad')).toBeNull();
  });

  it('returns the parsed draft when the JSON is valid', async () => {
    const slots = [
      {
        name: 'Onboarding ease',
        description: 'How smoothly the user got started.',
        theme: 'Friction',
        questionKeys: ['q1'],
        confidence: 0.9,
      },
    ];
    prismaMock.appDataSlotDraft.findUnique.mockResolvedValue({
      slots,
      updatedAt: new Date('2025-06-01T12:00:00Z'),
    });

    const draft = await loadDataSlotDraft('v-ok');

    expect(draft).not.toBeNull();
    // The updatedAt date is converted to ISO string — not passed through as a Date object.
    expect(draft?.updatedAt).toBe('2025-06-01T12:00:00.000Z');
    expect(draft?.slots).toHaveLength(1);
    expect(draft?.slots[0]?.name).toBe('Onboarding ease');
  });

  it('queries by versionId using the unique selector', async () => {
    prismaMock.appDataSlotDraft.findUnique.mockResolvedValue(null);
    await loadDataSlotDraft('v-q');

    expect(prismaMock.appDataSlotDraft.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v-q' } })
    );
  });
});

// ── upsertDataSlotDraft ───────────────────────────────────────────────────────

describe('upsertDataSlotDraft', () => {
  it('upserts the draft using versionId as the unique key', async () => {
    prismaMock.appDataSlotDraft.upsert.mockResolvedValue({});
    const slots = [
      { name: 'Goal clarity', description: 'D', theme: 'T', questionKeys: ['q1'], confidence: 0.8 },
    ];
    await upsertDataSlotDraft('v-1', slots);

    expect(prismaMock.appDataSlotDraft.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId: 'v-1' },
        create: expect.objectContaining({ versionId: 'v-1' }),
        update: expect.objectContaining({ slots: expect.anything() }),
      })
    );
  });

  it('passes the slots array in both create and update branches', async () => {
    prismaMock.appDataSlotDraft.upsert.mockResolvedValue({});
    const slots = [
      { name: 'Goal clarity', description: 'D', theme: 'T', questionKeys: ['q1'], confidence: 0.8 },
    ];
    await upsertDataSlotDraft('v-1', slots);

    const call = (prismaMock.appDataSlotDraft.upsert as Mock).mock.calls[0]?.[0];
    // Both create and update carry the slots payload (so a create OR update writes the data).
    expect(call?.create?.slots).toBeDefined();
    expect(call?.update?.slots).toBeDefined();
  });
});

// ── deleteDataSlotDraft ───────────────────────────────────────────────────────

describe('deleteDataSlotDraft', () => {
  it('calls deleteMany with the versionId (no-op-safe by deleteMany semantics)', async () => {
    prismaMock.appDataSlotDraft.deleteMany.mockResolvedValue({ count: 0 });
    await deleteDataSlotDraft('v-1');

    expect(prismaMock.appDataSlotDraft.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
  });
});

// ── buildDataSlotStructure ────────────────────────────────────────────────────

describe('buildDataSlotStructure', () => {
  const versionRow = {
    goal: 'Understand friction',
    audience: { role: 'developer' },
    sections: [
      {
        title: 'Intro',
        questions: [
          { key: 'q1', prompt: 'How easy was it?', type: 'scale' },
          { key: 'q2', prompt: 'What slowed you down?', type: 'text' },
        ],
      },
    ],
  };

  it('returns null when the version is not found (mismatched questionnaireId)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect(await buildDataSlotStructure('q-1', 'v-unknown')).toBeNull();
  });

  it('returns null when the version has no questions', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      goal: 'g',
      audience: null,
      sections: [{ title: 'S', questions: [] }],
    });
    expect(await buildDataSlotStructure('q-1', 'v-empty')).toBeNull();
  });

  it('flattens sections into a single question array with sectionTitle', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow);
    const structure = await buildDataSlotStructure('q-1', 'v-1');

    expect(structure).not.toBeNull();
    expect(structure?.questions).toHaveLength(2);
    expect(structure?.questions[0]).toMatchObject({
      key: 'q1',
      prompt: 'How easy was it?',
      type: 'scale',
      sectionTitle: 'Intro',
    });
    expect(structure?.questions[1]).toMatchObject({
      key: 'q2',
      sectionTitle: 'Intro',
    });
  });

  it('sets goal from the version row', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow);
    const structure = await buildDataSlotStructure('q-1', 'v-1');
    expect(structure?.goal).toBe('Understand friction');
  });

  it('converts null audience to undefined', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...versionRow,
      audience: null,
    });
    const structure = await buildDataSlotStructure('q-1', 'v-1');
    expect(structure?.audience).toBeUndefined();
  });

  it('queries with the correct scope (both questionnaireId AND versionId)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(versionRow);
    await buildDataSlotStructure('q-abc', 'v-xyz');

    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v-xyz', questionnaireId: 'q-abc' },
      })
    );
  });
});

// ── replaceDataSlots ──────────────────────────────────────────────────────────

describe('replaceDataSlots', () => {
  const INPUT_SLOTS: DataSlotInput[] = [
    { name: 'Onboarding ease', description: 'D1', theme: 'T1', questionKeys: ['q1', 'q2'] },
    { name: 'Blocker', description: 'D2', theme: 'T1', questionKeys: ['q3'] },
  ];

  beforeEach(() => {
    // Default: version has 3 questions.
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([
      { id: 'id-q1', key: 'q1' },
      { id: 'id-q2', key: 'q2' },
      { id: 'id-q3', key: 'q3' },
    ]);
    prismaMock.appDataSlot.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.appDataSlotDraft.deleteMany.mockResolvedValue({ count: 1 });
    // create returns unique ids per call.
    prismaMock.appDataSlot.create
      .mockResolvedValueOnce({ id: 'new-slot-1' })
      .mockResolvedValueOnce({ id: 'new-slot-2' });
    prismaMock.appDataSlotQuestion.createMany.mockResolvedValue({ count: 2 });
    // loadDataSlots is called at the end — return the new persisted slots.
    prismaMock.appDataSlot.findMany.mockResolvedValue([
      makeDbRow({
        id: 'new-slot-1',
        key: 'onboarding_ease',
        ordinal: 0,
        questions: [{ questionSlot: { key: 'q1' } }, { questionSlot: { key: 'q2' } }],
      }),
      makeDbRow({
        id: 'new-slot-2',
        key: 'blocker',
        ordinal: 1,
        questions: [{ questionSlot: { key: 'q3' } }],
      }),
    ]);
  });

  it('deletes existing slots AND the pending draft inside the transaction', async () => {
    await replaceDataSlots('v-1', INPUT_SLOTS);

    expect(prismaMock.appDataSlot.deleteMany).toHaveBeenCalledWith({ where: { versionId: 'v-1' } });
    expect(prismaMock.appDataSlotDraft.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
  });

  it('creates each slot with a derived slugified key and the correct ordinal', async () => {
    await replaceDataSlots('v-1', INPUT_SLOTS);

    const createCalls = (prismaMock.appDataSlot.create as Mock).mock.calls;
    expect(createCalls).toHaveLength(2);

    // Slot 0: name 'Onboarding ease' → key should be 'onboarding_ease', ordinal 0.
    expect(createCalls[0]?.[0]?.data).toMatchObject({
      versionId: 'v-1',
      key: 'onboarding_ease',
      name: 'Onboarding ease',
      ordinal: 0,
    });
    // Slot 1: name 'Blocker' → key 'blocker', ordinal 1.
    expect(createCalls[1]?.[0]?.data).toMatchObject({
      versionId: 'v-1',
      key: 'blocker',
      ordinal: 1,
    });
  });

  it('disambiguates duplicate slugs with _2, _3 … suffixes', async () => {
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-id' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);

    // Two slots that produce the same slug 'name'.
    const dupes: DataSlotInput[] = [
      { name: 'Name', description: 'D', theme: 'T', questionKeys: [] },
      { name: 'Name', description: 'D', theme: 'T', questionKeys: [] },
    ];
    await replaceDataSlots('v-1', dupes);

    const createCalls = (prismaMock.appDataSlot.create as Mock).mock.calls;
    const keys = createCalls.map((c) => c[0]?.data?.key as string);
    expect(keys[0]).toBe('name');
    expect(keys[1]).toBe('name_2'); // collision resolved by nextAvailableKey
  });

  it('creates question mappings for known question keys only (ignores unknown keys)', async () => {
    const slotWithUnknown: DataSlotInput[] = [
      { name: 'Slot A', description: 'D', theme: 'T', questionKeys: ['q1', 'q-unknown'] },
    ];
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-slot-x' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);

    await replaceDataSlots('v-1', slotWithUnknown);

    const manyCall = (prismaMock.appDataSlotQuestion.createMany as Mock).mock.calls[0]?.[0];
    // Only q1 is known; q-unknown must be silently dropped.
    expect(manyCall?.data).toHaveLength(1);
    expect(manyCall?.data[0]).toMatchObject({ questionSlotId: 'id-q1' });
  });

  it('skips createMany when a slot has no valid question mappings', async () => {
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-id' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);
    prismaMock.appDataSlotQuestion.createMany.mockReset();

    const noKeys: DataSlotInput[] = [
      { name: 'Empty', description: 'D', theme: 'T', questionKeys: ['q-gone'] },
    ];
    await replaceDataSlots('v-1', noKeys);

    expect(prismaMock.appDataSlotQuestion.createMany).not.toHaveBeenCalled();
  });

  it('deduplicates question keys before mapping', async () => {
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-id' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);

    const dupeKeys: DataSlotInput[] = [
      { name: 'Slot', description: 'D', theme: 'T', questionKeys: ['q1', 'q1', 'q2'] },
    ];
    await replaceDataSlots('v-1', dupeKeys);

    const manyCall = (prismaMock.appDataSlotQuestion.createMany as Mock).mock.calls[0]?.[0];
    // Deduplicated: q1 appears only once.
    expect(manyCall?.data).toHaveLength(2);
    const mappedIds = manyCall?.data.map((m: { questionSlotId: string }) => m.questionSlotId);
    expect(mappedIds).toContain('id-q1');
    expect(mappedIds).toContain('id-q2');
    expect(mappedIds.filter((id: string) => id === 'id-q1')).toHaveLength(1);
  });

  it('runs inside a transaction (executeTransaction called once)', async () => {
    await replaceDataSlots('v-1', INPUT_SLOTS);
    expect(executeTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted views (from loadDataSlots at the end)', async () => {
    const views = await replaceDataSlots('v-1', INPUT_SLOTS);
    expect(views).toHaveLength(2);
    expect(views[0]?.key).toBe('onboarding_ease');
    expect(views[1]?.key).toBe('blocker');
  });

  it('includes optional weight when provided', async () => {
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-id' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);

    const withWeight: DataSlotInput[] = [
      { name: 'Weighted', description: 'D', theme: 'T', questionKeys: [], weight: 5 },
    ];
    await replaceDataSlots('v-1', withWeight);

    const createCall = (prismaMock.appDataSlot.create as Mock).mock.calls[0]?.[0]?.data;
    expect(createCall?.weight).toBe(5);
  });

  it('omits weight from create data when not provided', async () => {
    prismaMock.appDataSlot.create.mockReset().mockResolvedValue({ id: 'new-id' });
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);

    const noWeight: DataSlotInput[] = [
      { name: 'Unweighted', description: 'D', theme: 'T', questionKeys: [] },
    ];
    await replaceDataSlots('v-1', noWeight);

    const createCall = (prismaMock.appDataSlot.create as Mock).mock.calls[0]?.[0]?.data;
    expect(createCall).not.toHaveProperty('weight');
  });
});
