/**
 * Unit tests for seed-topics.ts.
 *
 * `persist.test.ts` and `reingest.test.ts` both stub `appQuestionnaireSection.findMany`
 * to `[]`, so every call short-circuits before the "additive only" contract this file
 * exists for ever runs. These tests build a non-empty section/question/topic graph so
 * the uncovered-section computation, the ordinal-append base, and the reconcile
 * prune/delete/reseed sequence are actually exercised.
 *
 * `attachDataSlotsForVersion` is deliberately NOT covered here — it already has
 * dedicated coverage via `data-slot-routes.test.ts` (`replaceDataSlots — attaching the
 * slots to topics`), and duplicating it would just re-test the same pure
 * `planDataSlotAttachment` logic through a second seam.
 *
 * The tx passed to `seedTopicsForVersion` / `reconcileTopicsForVersion` is a plain
 * fake object (same pattern as `reingest.test.ts`), not a mocked module — these
 * functions take their Prisma client as an argument rather than importing one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  seedTopicsForVersion,
  reconcileTopicsForVersion,
  seedTopicsBestEffort,
} from '@/app/api/v1/app/questionnaires/_lib/seed-topics';
import { executeTransaction } from '@/lib/db/utils';
import { logger } from '@/lib/logging';

type Mock = ReturnType<typeof vi.fn>;
type FakeTx = Parameters<typeof seedTopicsForVersion>[0];

// ── fake transaction client ──────────────────────────────────────────────────

const tx = {
  appQuestionnaireSection: { findMany: vi.fn() },
  appQuestionSlot: { findMany: vi.fn() },
  appDataSlot: { findMany: vi.fn() },
  appQuestionnaireTopic: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
};

function asTx(): FakeTx {
  return tx as unknown as FakeTx;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: an empty graph, so any nested seed/attach pass a test does not care about is a no-op.
  tx.appQuestionnaireSection.findMany.mockResolvedValue([]);
  tx.appQuestionSlot.findMany.mockResolvedValue([]);
  tx.appDataSlot.findMany.mockResolvedValue([]);
  tx.appQuestionnaireTopic.findMany.mockResolvedValue([]);
  tx.appQuestionnaireTopic.createMany.mockResolvedValue({ count: 0 });
  tx.appQuestionnaireTopic.update.mockResolvedValue({});
  tx.appQuestionnaireTopic.deleteMany.mockResolvedValue({ count: 0 });
});

// ── seedTopicsForVersion ─────────────────────────────────────────────────────

describe('seedTopicsForVersion', () => {
  it('returns 0 and writes nothing when the version has no sections', async () => {
    const count = await seedTopicsForVersion(asTx(), 'v-1');
    expect(count).toBe(0);
    expect(tx.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });

  it('does not re-seed a section a topic already covers', async () => {
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's-covered', title: 'Already Covered', ordinal: 0 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1', sectionId: 's-covered' }]);
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { key: 'existing', members: { questionKeys: ['q1'], dataSlotKeys: [] } },
    ]);

    const count = await seedTopicsForVersion(asTx(), 'v-1');

    expect(count).toBe(0);
    expect(tx.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });

  it('seeds a section with no covering topic', async () => {
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's-uncovered', title: 'Uncovered Section', ordinal: 0 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1', sectionId: 's-uncovered' }]);
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([]);

    const count = await seedTopicsForVersion(asTx(), 'v-1');

    expect(count).toBe(1);
    const call = (tx.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ key: string; members: unknown }>;
    expect(written).toHaveLength(1);
    expect(written[0]?.members).toEqual({ questionKeys: ['q1'], dataSlotKeys: [] });
  });

  it('seeds only the uncovered section when one of two sections already has a topic', async () => {
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's-covered', title: 'Covered', ordinal: 0 },
      { id: 's-uncovered', title: 'Uncovered', ordinal: 1 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q1', sectionId: 's-covered' },
      { key: 'q2', sectionId: 's-uncovered' },
    ]);
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { key: 'covered-topic', members: { questionKeys: ['q1'], dataSlotKeys: [] } },
    ]);

    const count = await seedTopicsForVersion(asTx(), 'v-1');

    expect(count).toBe(1);
    const call = (tx.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ label: string }>;
    expect(written).toHaveLength(1);
    expect(written[0]?.label).toBe('Uncovered');
  });

  it('appends the new topic after existing ones — ordinal continues, does not restart at 0', async () => {
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's-new', title: 'New Section', ordinal: 0 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q-new', sectionId: 's-new' }]);
    // Two existing (already-authored) topics — the ordinal base the new one must append after.
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { key: 'existing-1', members: { questionKeys: ['q-old-1'], dataSlotKeys: [] } },
      { key: 'existing-2', members: { questionKeys: ['q-old-2'], dataSlotKeys: [] } },
    ]);

    await seedTopicsForVersion(asTx(), 'v-1');

    const call = (tx.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ ordinal: number }>;
    expect(written[0]?.ordinal).toBe(2);
  });

  it('treats a section as already covered once ANY of its questions is claimed by an existing topic', async () => {
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's1', title: 'Section One', ordinal: 0 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q1', sectionId: 's1' },
      { key: 'q2', sectionId: 's1' },
    ]);
    // A topic claims only q1 of the section's two questions. Coverage is membership-based, not
    // section-identity-based, so partial overlap is enough to count the section as covered — it
    // must NOT be re-seeded just because q2 individually isn't claimed by anything.
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { key: 'partial', members: { questionKeys: ['q1'], dataSlotKeys: [] } },
    ]);

    const count = await seedTopicsForVersion(asTx(), 'v-1');
    expect(count).toBe(0);
    expect(tx.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });
});

// ── reconcileTopicsForVersion ────────────────────────────────────────────────

describe('reconcileTopicsForVersion', () => {
  it('prunes a topic membership to keys that still exist, without deleting the topic', async () => {
    // A structure rewrite dropped q2 and ds1 — q1 survives.
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { id: 't1', members: { questionKeys: ['q1', 'q2'], dataSlotKeys: ['ds1'] } },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
    tx.appDataSlot.findMany.mockResolvedValue([]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    expect(tx.appQuestionnaireTopic.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { members: { questionKeys: ['q1'], dataSlotKeys: [] } },
    });
    // Still holds a live question — must survive, never appear in a delete.
    expect(tx.appQuestionnaireTopic.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes a topic emptied entirely by the rewrite, and logs it', async () => {
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { id: 't-gone', members: { questionKeys: ['q-deleted'], dataSlotKeys: [] } },
    ]);
    // Neither the question nor any data slot survived the rewrite.
    tx.appQuestionSlot.findMany.mockResolvedValue([]);
    tx.appDataSlot.findMany.mockResolvedValue([]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    expect(tx.appQuestionnaireTopic.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['t-gone'] } },
    });
    expect(tx.appQuestionnaireTopic.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'conditional topics: dropped topics emptied by a structure rewrite',
      { versionId: 'v-1', count: 1 }
    );
  });

  it('never deletes a topic that still holds a live question — regression guard', async () => {
    // A topic with a single live question must survive reconcile even though its data-slot
    // membership was entirely stripped by the rewrite.
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { id: 't-alive', members: { questionKeys: ['q-alive'], dataSlotKeys: ['ds-gone'] } },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q-alive' }]);
    tx.appDataSlot.findMany.mockResolvedValue([]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    expect(tx.appQuestionnaireTopic.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves a topic whose membership is fully unchanged untouched — the "untouched by rewrite" short-circuit', async () => {
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { id: 't-untouched', members: { questionKeys: ['q1'], dataSlotKeys: ['ds1'] } },
    ]);
    // Both q1 and ds1 are still live — nothing to prune. `questions: []` satisfies the shape the
    // nested attachDataSlotsForVersion pass also reads from this same mock.
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
    tx.appDataSlot.findMany.mockResolvedValue([{ key: 'ds1', questions: [] }]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    expect(tx.appQuestionnaireTopic.update).not.toHaveBeenCalled();
    expect(tx.appQuestionnaireTopic.deleteMany).not.toHaveBeenCalled();
  });

  it('prunes/deletes before reseeding — the survivor read happens before the section read', async () => {
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([
      { id: 't1', members: { questionKeys: ['q1'], dataSlotKeys: [] } },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1' }]);
    tx.appDataSlot.findMany.mockResolvedValue([]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    const reconcileReadOrder = (tx.appQuestionnaireTopic.findMany as Mock).mock
      .invocationCallOrder[0];
    const seedSectionReadOrder = (tx.appQuestionnaireSection.findMany as Mock).mock
      .invocationCallOrder[0];
    expect(reconcileReadOrder).toBeLessThan(seedSectionReadOrder);
  });

  it('reseeds a section the survivors do not cover, after pruning', async () => {
    // No existing topics at all — reconcile's prune loop is a no-op, but the seed pass that
    // follows must still lay down a topic for the one live section.
    tx.appQuestionnaireTopic.findMany.mockResolvedValue([]);
    tx.appQuestionnaireSection.findMany.mockResolvedValue([
      { id: 's1', title: 'New Section', ordinal: 0 },
    ]);
    tx.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q1', sectionId: 's1' }]);
    tx.appDataSlot.findMany.mockResolvedValue([]);

    await reconcileTopicsForVersion(asTx(), 'v-1');

    expect(tx.appQuestionnaireTopic.createMany).toHaveBeenCalledTimes(1);
    const call = (tx.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ label: string }>;
    expect(written[0]?.label).toBe('New Section');
  });

  it('does nothing at all when the version has no topics and no sections', async () => {
    await reconcileTopicsForVersion(asTx(), 'v-1');
    expect(tx.appQuestionnaireTopic.update).not.toHaveBeenCalled();
    expect(tx.appQuestionnaireTopic.deleteMany).not.toHaveBeenCalled();
    expect(tx.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });
});

// ── seedTopicsBestEffort ─────────────────────────────────────────────────────

describe('seedTopicsBestEffort', () => {
  it('logs the seeded count when topics were created', async () => {
    (executeTransaction as Mock).mockResolvedValue(3);

    await seedTopicsBestEffort('v-1');

    expect(logger.info).toHaveBeenCalledWith('conditional topics: seeded topics', {
      versionId: 'v-1',
      count: 3,
    });
  });

  it('does not log when nothing was seeded', async () => {
    (executeTransaction as Mock).mockResolvedValue(0);

    await seedTopicsBestEffort('v-1');

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows a failure and logs it, rather than throwing', async () => {
    (executeTransaction as Mock).mockRejectedValue(new Error('db unavailable'));

    await expect(seedTopicsBestEffort('v-1')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('conditional topics: topic seeding failed', {
      versionId: 'v-1',
      error: 'db unavailable',
    });
  });

  it('stringifies a non-Error rejection rather than passing it through raw', async () => {
    (executeTransaction as Mock).mockRejectedValue('plain string failure');

    await seedTopicsBestEffort('v-1');

    expect(logger.error).toHaveBeenCalledWith('conditional topics: topic seeding failed', {
      versionId: 'v-1',
      error: 'plain string failure',
    });
  });
});
