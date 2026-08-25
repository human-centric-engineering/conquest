/**
 * Unit tests for topic-routes.ts.
 *
 * Mocks prisma + executeTransaction at the boundary. Tests verify the real
 * transformations the module performs: projection via toTopic (enum
 * fallbacks), the replaceTopics delete-then-write-then-read transaction
 * (including the `source: 'manual'` stamp), and patchAdaptiveScopeSettings's
 * read-narrow-merge-write (preserving untouched fields, defaulting rule ids).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTopic: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  appQuestionnaireConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: typeof prismaMock) => Promise<unknown>) =>
    cb(prismaMock)
  ),
}));

import {
  toTopic,
  loadTopics,
  loadAdaptiveScopeSettings,
  replaceTopics,
  patchAdaptiveScopeSettings,
  TOPIC_SELECT,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { adaptiveScopeSettingsSchema } from '@/lib/app/questionnaire/scope/schemas';
import type { TopicInput, AdaptiveScopeSettingsPatch } from '@/lib/app/questionnaire/scope/schemas';
import { executeTransaction } from '@/lib/db/utils';

type Mock = ReturnType<typeof vi.fn>;

function makeTopicRow(
  over: Partial<{
    id: string;
    key: string;
    label: string;
    description: string | null;
    phase: string;
    criteria: string | null;
    depth: string;
    members: unknown;
    ordinal: number;
    source: string;
  }> = {}
) {
  return {
    id: over.id ?? 't-1',
    key: over.key ?? 'intro',
    label: over.label ?? 'Intro',
    description: over.description ?? null,
    phase: over.phase ?? 'core',
    criteria: over.criteria ?? null,
    depth: over.depth ?? 'full',
    members: over.members ?? { questionKeys: ['q1'], dataSlotKeys: [] },
    ordinal: over.ordinal ?? 0,
    source: over.source ?? 'manual',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── toTopic ───────────────────────────────────────────────────────────────────

describe('toTopic', () => {
  it('projects a db row to the pure Topic shape', () => {
    const row = makeTopicRow({
      id: 'x1',
      key: 'k',
      label: 'Label',
      description: 'D',
      phase: 'conditional',
      criteria: 'C',
      depth: 'light',
      members: { questionKeys: ['q1', 'q2'], dataSlotKeys: ['ds1'] },
      ordinal: 3,
      source: 'analyst',
    });
    expect(toTopic(row)).toEqual({
      id: 'x1',
      key: 'k',
      label: 'Label',
      description: 'D',
      phase: 'conditional',
      criteria: 'C',
      depth: 'light',
      members: { questionKeys: ['q1', 'q2'], dataSlotKeys: ['ds1'] },
      ordinal: 3,
      source: 'analyst',
    });
  });

  it('falls back an unrecognised phase to core', () => {
    const row = makeTopicRow({ phase: 'not-a-phase' });
    expect(toTopic(row).phase).toBe('core');
  });

  it('falls back an unrecognised depth to full', () => {
    const row = makeTopicRow({ depth: 'garbage' });
    expect(toTopic(row).depth).toBe('full');
  });

  it('falls back an unrecognised source to manual', () => {
    const row = makeTopicRow({ source: 'garbage' });
    expect(toTopic(row).source).toBe('manual');
  });

  it('narrows a malformed members blob to empty key lists', () => {
    const row = makeTopicRow({ members: 'not-an-object' });
    expect(toTopic(row).members).toEqual({ questionKeys: [], dataSlotKeys: [] });
  });
});

// ── TOPIC_SELECT ─────────────────────────────────────────────────────────────

describe('TOPIC_SELECT', () => {
  it('selects every field toTopic reads', () => {
    expect(TOPIC_SELECT).toEqual({
      id: true,
      key: true,
      label: true,
      description: true,
      phase: true,
      criteria: true,
      depth: true,
      members: true,
      ordinal: true,
      source: true,
    });
  });
});

// ── loadTopics ───────────────────────────────────────────────────────────────

describe('loadTopics', () => {
  it('queries the version in ordinal order and maps rows to Topics', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([
      makeTopicRow({ id: 'a', ordinal: 0 }),
      makeTopicRow({ id: 'b', ordinal: 1 }),
    ]);

    const topics = await loadTopics('v-1');

    expect(prismaMock.appQuestionnaireTopic.findMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });
    expect(topics.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when the version has no topics', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);
    expect(await loadTopics('v-empty')).toEqual([]);
  });
});

// ── loadAdaptiveScopeSettings ────────────────────────────────────────────────

describe('loadAdaptiveScopeSettings', () => {
  it('returns the defaults when no config row exists', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    const settings = await loadAdaptiveScopeSettings('v-1');
    expect(settings.enabled).toBe(false);
    expect(settings.maxConditionalTopics).toBe(3);
  });

  it('queries by versionId selecting only adaptiveScope', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    await loadAdaptiveScopeSettings('v-q');
    expect(prismaMock.appQuestionnaireConfig.findUnique).toHaveBeenCalledWith({
      where: { versionId: 'v-q' },
      select: { adaptiveScope: true },
    });
  });

  it('narrows a stored blob rather than passing it through raw', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: { enabled: true, maxConditionalTopics: 9999 },
    });
    const settings = await loadAdaptiveScopeSettings('v-1');
    expect(settings.enabled).toBe(true);
    // Clamped, not passed through raw.
    expect(settings.maxConditionalTopics).toBe(20);
  });
});

// ── replaceTopics ─────────────────────────────────────────────────────────────

describe('replaceTopics', () => {
  const INPUT_TOPICS: TopicInput[] = [
    {
      key: 'intro',
      label: 'Intro',
      description: 'About the intro',
      phase: 'opening',
      criteria: null,
      depth: 'full',
      questionKeys: ['q1'],
      dataSlotKeys: [],
    },
    {
      key: 'closing',
      label: 'Closing',
      description: null,
      phase: 'closing',
      criteria: 'Always relevant',
      depth: 'full',
      questionKeys: ['q2'],
      dataSlotKeys: ['ds1'],
    },
  ];

  beforeEach(() => {
    prismaMock.appQuestionnaireTopic.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.appQuestionnaireTopic.createMany.mockResolvedValue({ count: 2 });
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([
      makeTopicRow({ id: 't1', key: 'intro', ordinal: 0 }),
      makeTopicRow({ id: 't2', key: 'closing', ordinal: 1 }),
    ]);
  });

  it('deletes the existing topic set scoped to the version before writing', async () => {
    await replaceTopics('v-1', INPUT_TOPICS);

    expect(prismaMock.appQuestionnaireTopic.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
    const deleteOrder = (prismaMock.appQuestionnaireTopic.deleteMany as Mock).mock
      .invocationCallOrder[0];
    const createOrder = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock
      .invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('stamps every written topic source: manual, regardless of what was submitted', async () => {
    await replaceTopics('v-1', INPUT_TOPICS);

    const call = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ source: string }>;
    expect(written).toHaveLength(2);
    expect(written.every((t) => t.source === 'manual')).toBe(true);
  });

  it('writes each topic with its ordinal, key, and members derived from the input', async () => {
    await replaceTopics('v-1', INPUT_TOPICS);

    const call = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<Record<string, unknown>>;

    expect(written[0]).toMatchObject({
      versionId: 'v-1',
      key: 'intro',
      label: 'Intro',
      phase: 'opening',
      ordinal: 0,
      description: 'About the intro',
      members: { questionKeys: ['q1'], dataSlotKeys: [] },
    });
    expect(written[1]).toMatchObject({
      versionId: 'v-1',
      key: 'closing',
      ordinal: 1,
      members: { questionKeys: ['q2'], dataSlotKeys: ['ds1'] },
    });
  });

  it('omits the description key entirely when the topic has none (rather than writing null)', async () => {
    await replaceTopics('v-1', INPUT_TOPICS);

    const call = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<Record<string, unknown>>;
    expect(written[1]).not.toHaveProperty('description');
  });

  it('skips createMany entirely when the topic set is empty', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);
    await replaceTopics('v-1', []);

    expect(prismaMock.appQuestionnaireTopic.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
    expect(prismaMock.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });

  it('runs inside a transaction', async () => {
    await replaceTopics('v-1', INPUT_TOPICS);
    expect(executeTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted topics read back after the write', async () => {
    const result = await replaceTopics('v-1', INPUT_TOPICS);
    expect(result.map((t) => t.key)).toEqual(['intro', 'closing']);
  });
});

// ── patchAdaptiveScopeSettings ────────────────────────────────────────────────

describe('patchAdaptiveScopeSettings', () => {
  it('merges the patch onto the current settings, preserving fields the patch did not touch', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: {
        enabled: false,
        maxConditionalTopics: 5,
        plannerInstructions: 'Existing guidance',
        rules: [],
      },
    });
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    const patch: AdaptiveScopeSettingsPatch = { enabled: true };
    const result = await patchAdaptiveScopeSettings('v-1', patch);

    // The patched field changed...
    expect(result.enabled).toBe(true);
    // ...but fields the patch never mentioned survived the merge untouched.
    expect(result.maxConditionalTopics).toBe(5);
    expect(result.plannerInstructions).toBe('Existing guidance');
  });

  it('survives a lone-field patch that came through the real Zod schema, not a hand-built object', async () => {
    // The test above proves the MERGE preserves siblings. This one proves the thing the merge
    // depends on: that `adaptiveScopeSettingsSchema` omits absent optional keys from its output
    // rather than emitting them as `undefined`. `{ ...current, ...patch }` would happily write
    // `undefined` over a sibling, and every field on this schema is optional — so a lone-field
    // PATCH is the shape most likely to silently wipe the rest.
    //
    // It is a real risk rather than a hypothetical: the persistent on/off switch this tab is
    // getting sends exactly `{ enabled }` and nothing else.
    const parsed = adaptiveScopeSettingsSchema.parse({ enabled: true });
    expect(Object.keys(parsed)).toEqual(['enabled']);

    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: {
        enabled: false,
        maxConditionalTopics: 5,
        plannerInstructions: 'Existing guidance',
        fallbackTopicKeys: ['safe_default'],
        rules: [
          {
            id: 'r1',
            dataSlotKey: 'licence',
            operator: 'not_exists',
            value: null,
            action: 'exclude',
            topicKey: 'audit',
            ordinal: 0,
          },
        ],
      },
    });
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    const result = await patchAdaptiveScopeSettings('v-1', parsed);

    expect(result.enabled).toBe(true);
    expect(result.maxConditionalTopics).toBe(5);
    expect(result.plannerInstructions).toBe('Existing guidance');
    expect(result.fallbackTopicKeys).toEqual(['safe_default']);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ topicKey: 'audit', action: 'exclude' });
  });

  it('writes the merged blob through upsert, keyed by versionId', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: { enabled: false, maxConditionalTopics: 5, rules: [] },
    });
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    await patchAdaptiveScopeSettings('v-1', { enabled: true });

    const call = (prismaMock.appQuestionnaireConfig.upsert as Mock).mock.calls[0]?.[0];
    expect(call.where).toEqual({ versionId: 'v-1' });
    // Both create and update carry the merged blob, so the upsert works whichever branch fires.
    const updatePayload = call.update.adaptiveScope as {
      enabled: boolean;
      maxConditionalTopics: number;
    };
    const createPayload = call.create.adaptiveScope as { enabled: boolean };
    expect(updatePayload.enabled).toBe(true);
    expect(updatePayload.maxConditionalTopics).toBe(5);
    expect(createPayload.enabled).toBe(true);
    expect(call.create.versionId).toBe('v-1');
  });

  it('defaults a rule with no id to rule-<index>', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    const patch: AdaptiveScopeSettingsPatch = {
      rules: [
        { dataSlotKey: 'd1', operator: 'exists', value: null, action: 'include', topicKey: 't1' },
        {
          id: 'kept-id',
          dataSlotKey: 'd2',
          operator: 'equals',
          value: 'yes',
          action: 'exclude',
          topicKey: 't2',
        },
      ],
    };
    const result = await patchAdaptiveScopeSettings('v-1', patch);

    expect(result.rules[0]?.id).toBe('rule-0');
    expect(result.rules[1]?.id).toBe('kept-id');
    expect(result.rules[0]?.ordinal).toBe(0);
    expect(result.rules[1]?.ordinal).toBe(1);
  });

  it('keeps the current rules verbatim when the patch omits rules', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: {
        rules: [
          {
            id: 'r-existing',
            dataSlotKey: 'd1',
            operator: 'exists',
            value: null,
            action: 'include',
            topicKey: 't1',
            ordinal: 0,
          },
        ],
      },
    });
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    const result = await patchAdaptiveScopeSettings('v-1', { enabled: true });

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.id).toBe('r-existing');
  });

  it('replaces the rules wholesale when the patch supplies rules, rather than appending', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      adaptiveScope: {
        rules: [
          {
            id: 'old-rule',
            dataSlotKey: 'd-old',
            operator: 'exists',
            value: null,
            action: 'include',
            topicKey: 't-old',
            ordinal: 0,
          },
        ],
      },
    });
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});

    const patch: AdaptiveScopeSettingsPatch = {
      rules: [
        {
          dataSlotKey: 'd-new',
          operator: 'exists',
          value: null,
          action: 'include',
          topicKey: 't-new',
        },
      ],
    };
    const result = await patchAdaptiveScopeSettings('v-1', patch);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.dataSlotKey).toBe('d-new');
  });
});
