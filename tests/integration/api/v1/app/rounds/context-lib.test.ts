/**
 * Integration: the round Additional Context read + validation helpers (`_lib/context.ts`).
 *
 * The route tests mock this module to isolate handler branching, so the real query helpers are
 * exercised here against a mocked Prisma — the enrichment (denormalised question prompt), the
 * version-membership validations, and the briefable-questions resolution (pinned vs current launched).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appRoundContextEntry: { findMany: vi.fn(), findFirst: vi.fn() },
  appQuestionSlot: { findMany: vi.fn(), findFirst: vi.fn() },
  appQuestionnaireVersion: { findUnique: vi.fn(), findMany: vi.fn() },
  appQuestionnaireRoundItem: { findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  listRoundContextEntries,
  getRoundContextEntry,
  assertRoundBundlesVersion,
  assertSlotInVersion,
  loadVersionForSuggest,
  listBriefableQuestionnaires,
} from '@/app/api/v1/app/rounds/_lib/context';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

const entryRow = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  roundId: 'r1',
  versionId: 'v1',
  questionSlotId: null,
  title: 'Revenue',
  content: '£4m',
  source: 'manual',
  ordinal: 0,
  createdAt: new Date('2026-06-21T00:00:00Z'),
  updatedAt: new Date('2026-06-21T00:00:00Z'),
  ...over,
});

describe('listRoundContextEntries', () => {
  it('returns [] with no prompt sweep when there are no entries', async () => {
    (prismaMock.appRoundContextEntry.findMany as Mock).mockResolvedValue([]);
    expect(await listRoundContextEntries('r1')).toEqual([]);
    expect(prismaMock.appQuestionSlot.findMany).not.toHaveBeenCalled();
  });

  it('denormalises the attributed question prompt and leaves general entries null', async () => {
    (prismaMock.appRoundContextEntry.findMany as Mock).mockResolvedValue([
      entryRow({ id: 'e1', questionSlotId: null }),
      entryRow({ id: 'e2', questionSlotId: 'q1', title: 'Setup' }),
    ]);
    (prismaMock.appQuestionSlot.findMany as Mock).mockResolvedValue([
      { id: 'q1', prompt: 'How was setup?' },
    ]);
    const res = await listRoundContextEntries('r1');
    expect(res[0]).toMatchObject({ id: 'e1', questionPrompt: null });
    expect(res[1]).toMatchObject({ id: 'e2', questionPrompt: 'How was setup?' });
    // Prompt sweep queried only the attributed slot id.
    expect((prismaMock.appQuestionSlot.findMany as Mock).mock.calls[0][0].where.id.in).toEqual([
      'q1',
    ]);
  });

  it('passes a versionId filter through to the query', async () => {
    (prismaMock.appRoundContextEntry.findMany as Mock).mockResolvedValue([]);
    await listRoundContextEntries('r1', 'v9');
    expect((prismaMock.appRoundContextEntry.findMany as Mock).mock.calls[0][0].where).toMatchObject(
      {
        roundId: 'r1',
        versionId: 'v9',
      }
    );
  });
});

describe('getRoundContextEntry', () => {
  it('returns null for an unknown entry', async () => {
    (prismaMock.appRoundContextEntry.findFirst as Mock).mockResolvedValue(null);
    expect(await getRoundContextEntry('r1', 'nope')).toBeNull();
  });

  it('enriches an attributed entry with its question prompt', async () => {
    (prismaMock.appRoundContextEntry.findFirst as Mock).mockResolvedValue(
      entryRow({ questionSlotId: 'q1' })
    );
    (prismaMock.appQuestionSlot.findMany as Mock).mockResolvedValue([
      { id: 'q1', prompt: 'How was setup?' },
    ]);
    const res = await getRoundContextEntry('r1', 'e1');
    expect(res?.questionPrompt).toBe('How was setup?');
  });
});

describe('assertRoundBundlesVersion', () => {
  it('false when the version does not exist', async () => {
    (prismaMock.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(null);
    expect(await assertRoundBundlesVersion('r1', 'v1')).toBe(false);
    expect(prismaMock.appQuestionnaireRoundItem.findFirst).not.toHaveBeenCalled();
  });

  it('true when a round item pins the version or its questionnaire', async () => {
    (prismaMock.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      questionnaireId: 'qn1',
    });
    (prismaMock.appQuestionnaireRoundItem.findFirst as Mock).mockResolvedValue({ id: 'item1' });
    expect(await assertRoundBundlesVersion('r1', 'v1')).toBe(true);
    const where = (prismaMock.appQuestionnaireRoundItem.findFirst as Mock).mock.calls[0][0].where;
    expect(where.OR).toEqual([{ versionId: 'v1' }, { questionnaireId: 'qn1' }]);
  });

  it('false when no round item matches', async () => {
    (prismaMock.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      questionnaireId: 'qn1',
    });
    (prismaMock.appQuestionnaireRoundItem.findFirst as Mock).mockResolvedValue(null);
    expect(await assertRoundBundlesVersion('r1', 'v1')).toBe(false);
  });
});

describe('assertSlotInVersion', () => {
  it('true when the slot belongs to the version, false otherwise', async () => {
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue({ id: 'q1' });
    expect(await assertSlotInVersion('v1', 'q1')).toBe(true);
    (prismaMock.appQuestionSlot.findFirst as Mock).mockResolvedValue(null);
    expect(await assertSlotInVersion('v1', 'q9')).toBe(false);
  });
});

describe('loadVersionForSuggest', () => {
  it('null when the version is unknown', async () => {
    (prismaMock.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue(null);
    expect(await loadVersionForSuggest('v1')).toBeNull();
  });

  it('returns goal + flattened questions', async () => {
    (prismaMock.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({ goal: 'G' });
    (prismaMock.appQuestionSlot.findMany as Mock).mockResolvedValue([
      { id: 'q1', prompt: 'P1', section: { title: 'S1' } },
    ]);
    const res = await loadVersionForSuggest('v1');
    expect(res).toEqual({ goal: 'G', questions: [{ id: 'q1', prompt: 'P1', sectionTitle: 'S1' }] });
  });
});

describe('listBriefableQuestionnaires', () => {
  it('returns [] when the round has no items', async () => {
    (prismaMock.appQuestionnaireRoundItem.findMany as Mock).mockResolvedValue([]);
    expect(await listBriefableQuestionnaires('r1')).toEqual([]);
  });

  it('resolves a pinned version and lists its questions', async () => {
    (prismaMock.appQuestionnaireRoundItem.findMany as Mock).mockResolvedValue([
      { questionnaireId: 'qn1', versionId: 'v1', questionnaire: { title: 'Survey A' } },
    ]);
    (prismaMock.appQuestionSlot.findMany as Mock).mockResolvedValue([
      { id: 'q1', prompt: 'P1', versionId: 'v1', section: { title: 'S' } },
    ]);
    const res = await listBriefableQuestionnaires('r1');
    expect(res).toEqual([
      {
        questionnaireId: 'qn1',
        title: 'Survey A',
        versionId: 'v1',
        questions: [{ id: 'q1', prompt: 'P1', sectionTitle: 'S' }],
      },
    ]);
    // A pinned item needs no launched-version sweep.
    expect(prismaMock.appQuestionnaireVersion.findMany).not.toHaveBeenCalled();
  });

  it('resolves an unpinned item to its current launched version', async () => {
    (prismaMock.appQuestionnaireRoundItem.findMany as Mock).mockResolvedValue([
      { questionnaireId: 'qn1', versionId: null, questionnaire: { title: 'Survey A' } },
    ]);
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([
      { id: 'v-launched', questionnaireId: 'qn1' },
    ]);
    (prismaMock.appQuestionSlot.findMany as Mock).mockResolvedValue([
      { id: 'q1', prompt: 'P1', versionId: 'v-launched', section: { title: 'S' } },
    ]);
    const res = await listBriefableQuestionnaires('r1');
    expect(res[0].versionId).toBe('v-launched');
  });

  it('omits an unpinned item with no launched version', async () => {
    (prismaMock.appQuestionnaireRoundItem.findMany as Mock).mockResolvedValue([
      { questionnaireId: 'qn1', versionId: null, questionnaire: { title: 'Survey A' } },
    ]);
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([]);
    expect(await listBriefableQuestionnaires('r1')).toEqual([]);
  });
});
