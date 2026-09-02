/**
 * Unit tests for topic-draft.ts.
 *
 * Mocks prisma + executeTransaction at the boundary. Tests verify: the draft
 * CRUD read/write shape, acceptTopicDraft's transaction (topics AND rules
 * REPLACED rather than merged, `source: 'analyst'` stamped, the draft
 * cleared, all in one transaction), and buildRoutingAnalysisInput's
 * newest-source-document selection and its questions-empty null guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTopicDraft: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  appQuestionnaireTopic: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  appQuestionnaireConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  appQuestionnaireVersion: {
    findFirst: vi.fn(),
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn(async (cb: (tx: typeof prismaMock) => Promise<unknown>) =>
    cb(prismaMock)
  ),
}));

import {
  loadTopicDraft,
  saveTopicDraft,
  discardTopicDraft,
  acceptTopicDraft,
  buildRoutingAnalysisInput,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import {
  MAX_SUPPLEMENTARY_DOCUMENT_CHARS,
  SUPPLEMENTARY_TRUNCATION_MARKER,
} from '@/lib/app/questionnaire/scope/constants';
import type { AcceptTopicDraftBody } from '@/lib/app/questionnaire/scope/schemas';
import type { ProposedTopicSet } from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function makeTopicRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 't-1',
    key: 'intro',
    label: 'Intro',
    description: null,
    phase: 'core',
    criteria: null,
    depth: 'full',
    members: { questionKeys: ['q1'], dataSlotKeys: [] },
    ordinal: 0,
    source: 'analyst',
    ...over,
  };
}

function draftSet(over: Partial<ProposedTopicSet> = {}): ProposedTopicSet {
  return {
    v: 1,
    topics: [],
    gaps: [],
    summary: 'Summary',
    fromDocument: true,
    generatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── loadTopicDraft ───────────────────────────────────────────────────────────

describe('loadTopicDraft', () => {
  it('returns null when no draft row exists', async () => {
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(null);
    expect(await loadTopicDraft('v-1')).toBeNull();
  });

  it('queries by versionId, selecting only topics', async () => {
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(null);
    await loadTopicDraft('v-q');
    expect(prismaMock.appQuestionnaireTopicDraft.findUnique).toHaveBeenCalledWith({
      where: { versionId: 'v-q' },
      select: { topics: true },
    });
  });

  it('returns the parsed proposal when the stored JSON is valid', async () => {
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue({
      topics: draftSet({ summary: 'Found two topics' }),
    });
    const draft = await loadTopicDraft('v-1');
    expect(draft?.summary).toBe('Found two topics');
  });
});

// ── saveTopicDraft ───────────────────────────────────────────────────────────

describe('saveTopicDraft', () => {
  it('upserts the draft keyed by versionId, carrying the payload in both branches', async () => {
    prismaMock.appQuestionnaireTopicDraft.upsert.mockResolvedValue({});
    const draft = draftSet({ summary: 'A fresh run' });

    await saveTopicDraft('v-1', draft);

    const call = (prismaMock.appQuestionnaireTopicDraft.upsert as Mock).mock.calls[0]?.[0];
    expect(call.where).toEqual({ versionId: 'v-1' });
    expect(call.create).toEqual({ versionId: 'v-1', topics: draft });
    expect(call.update).toEqual({ topics: draft });
  });

  it('returns the same draft it was given', async () => {
    prismaMock.appQuestionnaireTopicDraft.upsert.mockResolvedValue({});
    const draft = draftSet();
    expect(await saveTopicDraft('v-1', draft)).toBe(draft);
  });
});

// ── discardTopicDraft ────────────────────────────────────────────────────────

describe('discardTopicDraft', () => {
  it('deletes the draft scoped to the version', async () => {
    prismaMock.appQuestionnaireTopicDraft.deleteMany.mockResolvedValue({ count: 1 });
    await discardTopicDraft('v-1');
    expect(prismaMock.appQuestionnaireTopicDraft.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
  });
});

// ── acceptTopicDraft ─────────────────────────────────────────────────────────

describe('acceptTopicDraft', () => {
  const BODY: AcceptTopicDraftBody = {
    topics: [
      {
        key: 'intro',
        label: 'Intro',
        description: null,
        phase: 'opening',
        criteria: null,
        depth: 'full',
        questionKeys: ['q1'],
        dataSlotKeys: [],
        trigger: null,
      },
    ],
  };

  beforeEach(() => {
    prismaMock.appQuestionnaireTopic.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.appQuestionnaireTopic.createMany.mockResolvedValue({ count: 1 });
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([makeTopicRow()]);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});
    prismaMock.appQuestionnaireTopicDraft.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('replaces the whole topic set: deletes the existing rows before writing the new ones', async () => {
    await acceptTopicDraft('v-1', BODY);

    expect(prismaMock.appQuestionnaireTopic.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
    const deleteOrder = (prismaMock.appQuestionnaireTopic.deleteMany as Mock).mock
      .invocationCallOrder[0];
    const createOrder = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock
      .invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('stamps every written topic source: analyst', async () => {
    await acceptTopicDraft('v-1', BODY);

    const call = (prismaMock.appQuestionnaireTopic.createMany as Mock).mock.calls[0]?.[0];
    const written = call?.data as Array<{ source: string; key: string; ordinal: number }>;
    expect(written).toEqual([
      expect.objectContaining({ key: 'intro', source: 'analyst', ordinal: 0, versionId: 'v-1' }),
    ]);
  });

  it('skips createMany when the accepted set is empty', async () => {
    await acceptTopicDraft('v-1', { topics: [] });
    expect(prismaMock.appQuestionnaireTopic.createMany).not.toHaveBeenCalled();
  });

  it('only touches maxConditionalTopics when the body supplies it', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      conditionalTopics: { maxConditionalTopics: 7, rules: [] },
    });

    const withoutCap = await acceptTopicDraft('v-1', BODY);
    expect(withoutCap.settings.maxConditionalTopics).toBe(7);

    const withCap = await acceptTopicDraft('v-1', { ...BODY, maxConditionalTopics: 2 });
    expect(withCap.settings.maxConditionalTopics).toBe(2);
  });

  it('only touches the two analyst-proposable settings when the body supplies them (F17.23)', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      conditionalTopics: {
        fallbackTopicKeys: ['existing_fallback'],
        checkTopicPreference: ['existing_check'],
      },
    });

    // Omitted leaves the version's own values alone — the same contract as rules and the cap, so
    // an accept from a proposal that said nothing about them cannot wipe hand-authored settings.
    const untouched = await acceptTopicDraft('v-1', BODY);
    expect(untouched.settings.fallbackTopicKeys).toEqual(['existing_fallback']);
    expect(untouched.settings.checkTopicPreference).toEqual(['existing_check']);

    const replaced = await acceptTopicDraft('v-1', {
      ...BODY,
      fallbackTopicKeys: ['wellbeing'],
      checkTopicPreference: ['wellbeing'],
    });
    expect(replaced.settings.fallbackTopicKeys).toEqual(['wellbeing']);
    expect(replaced.settings.checkTopicPreference).toEqual(['wellbeing']);
  });

  it('never touches enabled — accepting a proposal is authoring, not activation', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      conditionalTopics: { enabled: true, rules: [] },
    });
    const result = await acceptTopicDraft('v-1', BODY);
    expect(result.settings.enabled).toBe(true);
  });

  it('leaves an off version off when the body carries no enable (F17.22 Phase 4)', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      conditionalTopics: { enabled: false, rules: [] },
    });
    const result = await acceptTopicDraft('v-1', BODY);
    expect(result.settings.enabled).toBe(false);
  });

  it('turns the feature on when the admin ticked the offer', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      conditionalTopics: { enabled: false, rules: [] },
    });
    const result = await acceptTopicDraft('v-1', { ...BODY, enable: true });

    expect(result.settings.enabled).toBe(true);
    // Persisted, not merely returned: the whole point is that the next respondent gets a plan.
    const written = (prismaMock.appQuestionnaireConfig.upsert as Mock).mock.calls[0][0];
    expect(written.update.conditionalTopics.enabled).toBe(true);
    expect(written.create.conditionalTopics.enabled).toBe(true);
  });

  it('clears the pending draft as part of the same transaction', async () => {
    await acceptTopicDraft('v-1', BODY);
    expect(prismaMock.appQuestionnaireTopicDraft.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'v-1' },
    });
  });

  it('returns the topics read back from the write, mapped to the pure Topic shape', async () => {
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([
      makeTopicRow({ id: 't-9', key: 'intro' }),
    ]);
    const result = await acceptTopicDraft('v-1', BODY);
    expect(result.topics).toEqual([
      expect.objectContaining({ id: 't-9', key: 'intro', source: 'analyst' }),
    ]);
  });
});

// ── buildRoutingAnalysisInput ────────────────────────────────────────────────

describe('buildRoutingAnalysisInput', () => {
  const baseVersionRow = {
    goal: 'Understand friction',
    audience: { role: 'developer' },
    sections: [
      {
        title: 'Intro',
        questions: [{ key: 'q1', prompt: 'How easy was it?' }],
      },
    ],
    dataSlots: [{ key: 'ds1', name: 'Onboarding ease', theme: 'Friction' }],
    sourceDocuments: [],
    topics: [],
  };

  it('returns null when the version is not found for the given questionnaireId/versionId pair', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect(await buildRoutingAnalysisInput('q-1', 'v-unknown')).toBeNull();
  });

  it('returns null when the version has zero questions', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sections: [{ title: 'Empty section', questions: [] }],
    });
    expect(await buildRoutingAnalysisInput('q-1', 'v-empty')).toBeNull();
  });

  it('picks the newest PRIMARY document, not the first one written', async () => {
    // A faithful fake of what the real query does: `orderBy: { createdAt: 'desc' }` on
    // `sourceDocuments` means the DB — not this module — hands back the rows newest-first. If the
    // real query ever regressed to `asc`, this fake reproduces exactly that regression, because it
    // re-derives its answer from the query args on every call.
    const documents = [
      {
        id: 'doc-old',
        role: 'primary',
        fileName: 'v1.docx',
        extractedText: 'OLD TEXT',
        createdAt: new Date('2024-01-01'),
      },
      {
        id: 'doc-new',
        role: 'primary',
        fileName: 'v2.docx',
        extractedText: 'NEW TEXT',
        createdAt: new Date('2025-06-01'),
      },
    ];
    prismaMock.appQuestionnaireVersion.findFirst.mockImplementation(
      async (args: { select: { sourceDocuments: { orderBy: { createdAt: 'asc' | 'desc' } } } }) => {
        const { orderBy } = args.select.sourceDocuments;
        const sorted = [...documents].sort((a, b) =>
          orderBy.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime()
        );
        return {
          ...baseVersionRow,
          sourceDocuments: sorted.map((d) => ({
            fileName: d.fileName,
            extractedText: d.extractedText,
            role: d.role,
          })),
        };
      }
    );

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    expect(input?.documents).toEqual([{ role: 'primary', fileName: 'v2.docx', text: 'NEW TEXT' }]);
  });

  it('queries sourceDocuments ordered newest-first, and no longer takes only one', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(baseVersionRow);
    await buildRoutingAnalysisInput('q-1', 'v-1');

    const call = (prismaMock.appQuestionnaireVersion.findFirst as Mock).mock.calls[0]?.[0];
    expect(call.select.sourceDocuments).toMatchObject({ orderBy: { createdAt: 'desc' } });
    // `take: 1` was the bug: the companions were on the row and the query threw them away.
    expect(call.select.sourceDocuments).not.toHaveProperty('take');
  });

  it('returns an empty document list when the version has no source document', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [],
    });
    const input = await buildRoutingAnalysisInput('q-1', 'v-1');
    expect(input?.documents).toEqual([]);
  });

  it('carries supporting documents beside the instrument, oldest attachment first', async () => {
    // The point of the feature: an instrument delivered as a question bank plus a routing memo.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [
        { role: 'supplementary', fileName: 'memo-2.md', extractedText: 'SECOND' },
        { role: 'supplementary', fileName: 'memo-1.md', extractedText: 'FIRST' },
        { role: 'primary', fileName: 'bank.md', extractedText: 'INSTRUMENT' },
      ],
    });

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    expect(input?.documents.map((d) => [d.role, d.fileName, d.text])).toEqual([
      ['primary', 'bank.md', 'INSTRUMENT'],
      // Rows arrive newest-first; the companions are reversed so the one attached FIRST is read
      // first — and keeps its text when the budget runs out.
      ['supplementary', 'memo-1.md', 'FIRST'],
      ['supplementary', 'memo-2.md', 'SECOND'],
    ]);
  });

  it('truncates a supporting document that overruns the budget, and marks the seam', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [
        {
          role: 'supplementary',
          fileName: 'huge.md',
          extractedText: 'x'.repeat(MAX_SUPPLEMENTARY_DOCUMENT_CHARS + 500),
        },
      ],
    });

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    const document = input!.documents[0];
    expect(document?.truncated).toBe(true);
    expect(document?.text).toContain(SUPPLEMENTARY_TRUNCATION_MARKER);
    expect(document?.text.length).toBe(
      MAX_SUPPLEMENTARY_DOCUMENT_CHARS + SUPPLEMENTARY_TRUNCATION_MARKER.length
    );
  });

  it('names a supporting document the budget could not reach rather than dropping it', async () => {
    // Dropping it silently is the failure this whole feature exists to end: the analyst reports
    // confidently on an instrument whose routing page it never saw.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [
        { role: 'supplementary', fileName: 'second.md', extractedText: 'still matters' },
        {
          role: 'supplementary',
          fileName: 'first.md',
          extractedText: 'x'.repeat(MAX_SUPPLEMENTARY_DOCUMENT_CHARS),
        },
      ],
    });

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    expect(input?.documents.map((d) => [d.fileName, d.omitted ?? false])).toEqual([
      ['first.md', false],
      ['second.md', true],
    ]);
    expect(input?.documents[1]?.text).toBe('');
  });

  it('does not budget the instrument — it is passed whole, as it always was', async () => {
    // Shrinking the primary document here would change what the analyst proposes on versions
    // nobody has touched, which is not a thing a new feature is allowed to do.
    const long = 'y'.repeat(MAX_SUPPLEMENTARY_DOCUMENT_CHARS * 2);
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [{ role: 'primary', fileName: 'big.md', extractedText: long }],
    });

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    expect(input?.documents[0]?.text).toBe(long);
    expect(input?.documents[0]?.truncated).toBeUndefined();
  });

  it('reads a row written before the role column as the instrument', async () => {
    // Every legacy row defaults to `primary`; a version that has only those must read exactly as
    // it did before the column existed.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      sourceDocuments: [{ role: 'primary', fileName: 'legacy.docx', extractedText: 'LEGACY' }],
    });

    const input = await buildRoutingAnalysisInput('q-1', 'v-1');

    expect(input?.documents).toEqual([
      { role: 'primary', fileName: 'legacy.docx', text: 'LEGACY' },
    ]);
  });

  it('flattens sections into questions, carrying the sectionTitle', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(baseVersionRow);
    const input = await buildRoutingAnalysisInput('q-1', 'v-1');
    expect(input?.questions).toEqual([
      { key: 'q1', prompt: 'How easy was it?', sectionTitle: 'Intro' },
    ]);
  });

  it('converts a null audience to undefined', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      audience: null,
    });
    const input = await buildRoutingAnalysisInput('q-1', 'v-1');
    expect(input?.audience).toBeUndefined();
  });

  it('maps existingTopics through toTopic', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...baseVersionRow,
      topics: [makeTopicRow({ id: 't-1', key: 'intro' })],
    });
    const input = await buildRoutingAnalysisInput('q-1', 'v-1');
    expect(input?.existingTopics).toEqual([expect.objectContaining({ id: 't-1', key: 'intro' })]);
  });

  it('queries scoped to both questionnaireId and versionId', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(baseVersionRow);
    await buildRoutingAnalysisInput('q-abc', 'v-xyz');

    const call = (prismaMock.appQuestionnaireVersion.findFirst as Mock).mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'v-xyz', questionnaireId: 'q-abc' });
  });
});

// ── Mid-interview triggers (F17.31a) ─────────────────────────────────────────

describe('acceptTopicDraft — a recorded trigger', () => {
  const trigger = {
    condition: 'The applicant discloses that they are fleeing abuse',
    cues: ['abuse', 'fleeing'],
    sourceQuote: 'If the applicant discloses, at any stage, that they are fleeing abuse',
  };

  beforeEach(() => {
    prismaMock.appQuestionnaireTopic.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.appQuestionnaireTopic.createMany.mockResolvedValue({ count: 1 });
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([makeTopicRow()]);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue({});
    prismaMock.appQuestionnaireTopicDraft.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('writes it with the accepted topic, so it outlives the proposal', async () => {
    await acceptTopicDraft('v-1', {
      topics: [
        {
          key: 'abuse',
          label: 'Domestic abuse',
          description: null,
          phase: 'conditional',
          criteria: 'The opening indicates the applicant is fleeing abuse.',
          depth: 'full',
          questionKeys: ['q1'],
          dataSlotKeys: [],
          trigger,
        },
      ],
    });

    const created = prismaMock.appQuestionnaireTopic.createMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>[];
    };
    expect(created.data[0]?.trigger).toEqual(trigger);
  });

  it('omits the column for an ordinary accepted topic', async () => {
    await acceptTopicDraft('v-1', {
      topics: [
        {
          key: 'intro',
          label: 'Intro',
          description: null,
          phase: 'opening',
          criteria: null,
          depth: 'full',
          questionKeys: ['q1'],
          dataSlotKeys: [],
          trigger: null,
        },
      ],
    });

    const created = prismaMock.appQuestionnaireTopic.createMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>[];
    };
    expect(created.data[0]).not.toHaveProperty('trigger');
  });
});
