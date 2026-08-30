/**
 * Unit test: the shared topic-membership writers (F17.35).
 *
 * These are the one implementation four authoring paths share — the judge apply engine, the manual
 * question routes, extraction review, and definition import. What is asserted here is what those
 * four all depend on and none of them re-checks:
 *
 *  - a version with no topics is left completely alone (the overwhelmingly common shape);
 *  - only topics that actually change are written, which is what makes a 30-topic version cost one
 *    UPDATE instead of thirty;
 *  - every write is `updateMany`, so a row a concurrent Topics-tab save removed is a no-op rather
 *    than a P2025 that would abort the caller's transaction and roll back the question with it;
 *  - `source` is never stamped, because two unrelated gates read it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTopic: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  appQuestionSlot: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  copyTopicMembership,
  inheritTopicMembership,
  pruneTopicMembership,
  sectionQuestionKeys,
} from '@/app/api/v1/app/questionnaires/_lib/topic-membership';

type Mock = ReturnType<typeof vi.fn>;

// One alias for both surfaces: the membership writers need `appQuestionnaireTopic`,
// `sectionQuestionKeys` needs `appQuestionSlot`, and the mock stands in for both.
const client = prismaMock as unknown as Parameters<typeof pruneTopicMembership>[0] &
  Parameters<typeof sectionQuestionKeys>[0];

const TOPICS = [
  {
    id: 't-open',
    key: 'opening',
    ordinal: 0,
    members: { questionKeys: ['q_a'], dataSlotKeys: ['slot_1'] },
  },
  {
    id: 't-depth',
    key: 'depth',
    ordinal: 1,
    members: { questionKeys: ['q_a', 'q_b'], dataSlotKeys: [] },
  },
  { id: 't-far', key: 'far', ordinal: 2, members: { questionKeys: ['q_z'], dataSlotKeys: [] } },
];

function writes() {
  return (prismaMock.appQuestionnaireTopic.updateMany as Mock).mock.calls.map(
    (c: unknown[]) =>
      c[0] as {
        where: { id: string };
        data: { members: { questionKeys: string[]; dataSlotKeys: string[] } };
      }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
});

describe('pruneTopicMembership', () => {
  it('removes the key from every topic that held it', async () => {
    await pruneTopicMembership(client, 'v1', 'q_a');

    expect(writes().map((w) => w.where.id)).toEqual(['t-open', 't-depth']);
    expect(writes()[0].data.members.questionKeys).toEqual([]);
    expect(writes()[1].data.members.questionKeys).toEqual(['q_b']);
  });

  it('writes only the topics that change', async () => {
    await pruneTopicMembership(client, 'v1', 'q_a');

    expect(writes().map((w) => w.where.id)).not.toContain('t-far');
  });

  it('leaves data slots alone', async () => {
    await pruneTopicMembership(client, 'v1', 'q_a');

    expect(writes()[0].data.members.dataSlotKeys).toEqual(['slot_1']);
  });

  it('writes nothing for a key no topic held', async () => {
    await pruneTopicMembership(client, 'v1', 'q_never_in_a_topic');

    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the version has no topics', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);

    await pruneTopicMembership(client, 'v1', 'q_a');

    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });
});

describe('copyTopicMembership', () => {
  it('adds the new key to every topic the source belonged to', async () => {
    await copyTopicMembership(client, 'v1', 'q_a', 'q_a_second_half');

    expect(writes().map((w) => w.where.id)).toEqual(['t-open', 't-depth']);
    expect(writes()[0].data.members.questionKeys).toEqual(['q_a', 'q_a_second_half']);
    expect(writes()[1].data.members.questionKeys).toEqual(['q_a', 'q_b', 'q_a_second_half']);
  });

  it('writes nothing when the source belongs to no topic', async () => {
    await copyTopicMembership(client, 'v1', 'q_orphan', 'q_new');

    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent — a second copy writes nothing', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([
      {
        id: 't',
        key: 't',
        ordinal: 0,
        members: { questionKeys: ['q_a', 'q_b'], dataSlotKeys: [] },
      },
    ]);

    await copyTopicMembership(client, 'v1', 'q_a', 'q_b');

    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });
});

describe('inheritTopicMembership', () => {
  it('joins the majority owner of the siblings and reports which', async () => {
    const joined = await inheritTopicMembership(client, 'v1', 'q_new', ['q_a', 'q_b']);

    expect(joined).toBe('depth');
    expect(writes()).toHaveLength(1);
    expect(writes()[0].where.id).toBe('t-depth');
    expect(writes()[0].data.members.questionKeys).toEqual(['q_a', 'q_b', 'q_new']);
  });

  it('returns null and writes nothing when no topic owns any sibling', async () => {
    // The question exists and cannot be asked. Null is how the caller learns to say so.
    const joined = await inheritTopicMembership(client, 'v1', 'q_new', ['q_unknown']);

    expect(joined).toBeNull();
    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });

  it('returns undefined when the version has no topics — nothing to decide', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);

    expect(await inheritTopicMembership(client, 'v1', 'q_new', ['q_a'])).toBeUndefined();
  });
});

describe('every write', () => {
  it('goes through updateMany, never update', async () => {
    // `update` throws P2025 when a concurrent `replaceTopics` has removed the row — and a thrown
    // query inside a Postgres transaction aborts it, taking the caller's question write with it.
    await pruneTopicMembership(client, 'v1', 'q_a');
    await copyTopicMembership(client, 'v1', 'q_a', 'q_c');
    await inheritTopicMembership(client, 'v1', 'q_d', ['q_a']);

    expect(prismaMock.appQuestionnaireTopic.updateMany).toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireTopic.update).not.toHaveBeenCalled();
  });

  it('never stamps source', async () => {
    // `isEligibleForScopeCandidacy` and the launch readiness check both gate on
    // `source: { not: 'seeded' }`; flipping it here would suppress the Routing Analyst check.
    await pruneTopicMembership(client, 'v1', 'q_a');
    await inheritTopicMembership(client, 'v1', 'q_d', ['q_a']);

    for (const write of writes()) expect(write.data).not.toHaveProperty('source');
  });
});

describe('sectionQuestionKeys', () => {
  it('returns the section’s keys, which is what inheritance reads', async () => {
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q_a' }, { key: 'q_b' }]);

    expect(await sectionQuestionKeys(client, 'sec-1')).toEqual(['q_a', 'q_b']);
    expect(prismaMock.appQuestionSlot.findMany).toHaveBeenCalledWith({
      where: { sectionId: 'sec-1' },
      select: { key: true },
    });
  });
});
