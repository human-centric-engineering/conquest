/**
 * Unit tests for copyVersionGraph — the deep-copy kernel shared by the version fork and
 * the duplicate service.
 *
 * Calls `copyVersionGraph(tx, sourceVersionId, targetVersionId)` directly with a fake tx,
 * focused entirely on the null-guard else-branches that the existing fork and duplicate
 * integration tests don't reach:
 *
 *   - source has no config row        → appQuestionnaireConfig.create NOT called
 *   - source has no scoringSchema     → appScoringSchema.create NOT called
 *   - section description is null     → `description` key absent from section-create payload
 *   - question optional fields null   → guidelines / rationale / typeConfig /
 *                                       extractionConfidence absent from createMany payload
 *   - empty sections (no questions)   → appQuestionSlot.createMany NOT called for that section
 *   - zero tags                       → appQuestionTag.create + appQuestionSlotTag.createMany
 *                                       NOT called
 *   - zero data slots                 → appDataSlot.create + appDataSlotQuestion.createMany
 *                                       NOT called
 *   - returned id maps are correct    → sectionIdMap / questionIdMap populated;
 *                                       tagIdMap / dataSlotIdMap are empty
 *
 * The embedding copy calls ($executeRawUnsafe) are verified against actual SQL
 * table names to confirm the code — not the mock — picked the right tables.
 *
 * @see app/api/v1/app/questionnaires/_lib/copy-version-graph.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (hoisted before any imports) ────────────────────────────────

/**
 * `executeTransaction` is imported by copy-version-graph.ts only to derive the
 * `CopyTx` type — it's never called from within `copyVersionGraph`. Mock it to
 * prevent the real db/utils module from loading.
 */
vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));

/**
 * authoring-routes (imported transitively for `jsonInput`) reads prisma at load
 * time — mock the client to prevent a real DB connection attempt.
 */
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionSlot: { findFirst: vi.fn() } },
}));

// ─── System under test ────────────────────────────────────────────────────────

import { copyVersionGraph } from '@/app/api/v1/app/questionnaires/_lib/copy-version-graph';

// ─── Types ────────────────────────────────────────────────────────────────────

type Mock = ReturnType<typeof vi.fn>;

// ─── Tx mock factory ──────────────────────────────────────────────────────────

/**
 * Build a fresh fake transaction client for each test. The `$executeRawUnsafe`
 * is used by `copySlotEmbeddings` and `copyDataSlotEmbeddings` to carry over
 * pgvector embeddings via raw SQL — a Prisma-Unsupported column.
 */
function buildTx() {
  let sectionSeq = 0;
  return {
    appQuestionnaireVersion: {
      findUniqueOrThrow: vi.fn(),
    },
    appQuestionnaireConfig: {
      create: vi.fn(async () => ({ id: 'new-cfg' })),
    },
    appScoringSchema: {
      create: vi.fn(async () => ({ id: 'new-schema' })),
    },
    appQuestionnaireSection: {
      create: vi.fn(async () => ({ id: `newsec-${++sectionSeq}` })),
    },
    appQuestionSlot: {
      createMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [] as Array<{ id: string; key: string }>),
    },
    appQuestionTag: {
      create: vi.fn(async () => ({ id: 'new-tag' })),
    },
    appQuestionSlotTag: {
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    appDataSlot: {
      create: vi.fn(async () => ({ id: 'new-ds' })),
    },
    appDataSlotQuestion: {
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    $executeRawUnsafe: vi.fn(async () => 0),
  };
}

// ─── Minimal source fixture ───────────────────────────────────────────────────

/**
 * A MINIMAL source version:
 *   - no config row (null)                → tests config else-branch
 *   - no scoring schema (null)            → tests scoringSchema else-branch
 *   - one section with description=null   → tests section description else-branch
 *   - one question with all optional fields null  → tests all four question else-branches
 *   - a second empty section (questions=[])       → tests empty-section branch
 *   - zero tags                                   → tests tag loop not reached
 *   - zero data slots                             → tests data-slot loop not reached
 */
const MINIMAL_SOURCE = {
  config: null,
  scoringSchema: null,
  tags: [] as Array<{
    id: string;
    label: string;
    normalizedLabel: string;
    color: string | null;
    slots: Array<{ questionSlotId: string }>;
  }>,
  dataSlots: [] as Array<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    theme: string | null;
    ordinal: number;
    weight: number | null;
    generationConfidence: number | null;
    questions: Array<{ questionSlotId: string }>;
  }>,
  sections: [
    {
      id: 'oldsec-1',
      ordinal: 0,
      title: 'About',
      description: null, // ← null-description else-branch
      questions: [
        {
          id: 'oldq-1',
          ordinal: 0,
          key: 'respondent_name',
          prompt: 'What is your name?',
          guidelines: null, // ← null-guidelines else-branch
          rationale: null, // ← null-rationale else-branch
          type: 'free_text',
          typeConfig: null, // ← null-typeConfig else-branch
          required: true,
          weight: 1,
          extractionConfidence: null, // ← null-extractionConfidence else-branch
        },
      ],
    },
    {
      id: 'oldsec-2',
      ordinal: 1,
      title: 'Empty',
      description: null,
      questions: [], // ← empty-section branch (createMany skipped)
    },
  ],
};

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('copyVersionGraph — null-guard else-branches', () => {
  let tx: ReturnType<typeof buildTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = buildTx();
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(MINIMAL_SOURCE);
    // After createMany the function re-reads slots by key to build questionIdMap.
    tx.appQuestionSlot.findMany.mockResolvedValue([{ id: 'newq-1', key: 'respondent_name' }]);
  });

  // ── Config branch ──────────────────────────────────────────────────────────

  describe('config', () => {
    it('does not create a config row when the source has no config (null)', async () => {
      // Act: minimal source has config=null
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: the else-branch is taken — no config write
      expect(tx.appQuestionnaireConfig.create).not.toHaveBeenCalled();
    });
  });

  // ── Scoring schema branch ──────────────────────────────────────────────────

  describe('scoringSchema', () => {
    it('does not create a scoring-schema row when the source has none (null)', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: the else-branch is taken — no schema write
      expect(tx.appScoringSchema.create).not.toHaveBeenCalled();
    });
  });

  // ── Section description branch ─────────────────────────────────────────────

  describe('section description', () => {
    it('omits the description key from the section-create payload when description is null', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: section create was called, but without `description`
      expect(tx.appQuestionnaireSection.create).toHaveBeenCalled();
      const firstCall = (tx.appQuestionnaireSection.create as Mock).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(firstCall.data).toMatchObject({ versionId: 'tgt-v', title: 'About' });
      // The source has description=null → the code uses `...(null !== null ? ... : {})`
      // which is the empty spread, so `description` must NOT appear on the payload.
      expect(firstCall.data).not.toHaveProperty('description');
    });
  });

  // ── Question optional fields branches ─────────────────────────────────────

  describe('question optional fields', () => {
    it('omits guidelines, rationale, typeConfig, and extractionConfidence from createMany when all are null', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: createMany was called for the section that HAS questions
      expect(tx.appQuestionSlot.createMany).toHaveBeenCalledTimes(1);
      const rows = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);

      // Required fields are present
      expect(rows[0]).toMatchObject({
        versionId: 'tgt-v',
        ordinal: 0,
        key: 'respondent_name',
        prompt: 'What is your name?',
        type: 'free_text',
        required: true,
        weight: 1,
      });

      // All-null optional fields must be absent (not written as null columns)
      expect(rows[0]).not.toHaveProperty('guidelines');
      expect(rows[0]).not.toHaveProperty('rationale');
      expect(rows[0]).not.toHaveProperty('typeConfig');
      expect(rows[0]).not.toHaveProperty('extractionConfidence');
    });
  });

  // ── Empty section branch ───────────────────────────────────────────────────

  describe('empty sections', () => {
    it('skips createMany for a section with no questions', async () => {
      // Arrange: source has two sections — one with 1 question, one with 0
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: createMany called exactly once (for the non-empty section only)
      expect(tx.appQuestionnaireSection.create).toHaveBeenCalledTimes(2);
      expect(tx.appQuestionSlot.createMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── Zero tags branch ───────────────────────────────────────────────────────

  describe('zero tags', () => {
    it('does not create any tags or slot-tag links when the source has no tags', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: neither the tag nor the assignment write was reached
      expect(tx.appQuestionTag.create).not.toHaveBeenCalled();
      expect(tx.appQuestionSlotTag.createMany).not.toHaveBeenCalled();
    });
  });

  // ── Zero data slots branch ─────────────────────────────────────────────────

  describe('zero data slots', () => {
    it('does not create any data slots or data-slot-question links when the source has none', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: no data-slot or data-slot-question writes
      expect(tx.appDataSlot.create).not.toHaveBeenCalled();
      expect(tx.appDataSlotQuestion.createMany).not.toHaveBeenCalled();
    });
  });

  // ── Embedding copy ─────────────────────────────────────────────────────────

  describe('embedding copy', () => {
    it('carries question-slot and data-slot embeddings via raw SQL keyed on version id', async () => {
      // Act
      await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: $executeRawUnsafe was called for both slot tables
      const sqls = (tx.$executeRawUnsafe as Mock).mock.calls.map((c) => c[0] as string);
      const questionCopy = sqls.find((sql) => sql.includes('"app_question_slot"'));
      const dataCopy = sqls.find((sql) => sql.includes('"app_data_slot"'));

      // Both SQL strings must reference the key-join — the code did this, not the mock
      expect(questionCopy).toMatch(/tgt\."key" = src\."key"/);
      expect(dataCopy).toMatch(/tgt\."key" = src\."key"/);

      // Both must bind target=$1, source=$2
      for (const call of (tx.$executeRawUnsafe as Mock).mock.calls) {
        expect(call.slice(1)).toEqual(['tgt-v', 'src-v']);
      }
    });
  });

  // ── Return value ───────────────────────────────────────────────────────────

  describe('return value', () => {
    it('populates sectionIdMap and questionIdMap and returns empty tagIdMap and dataSlotIdMap', async () => {
      // Act
      const result = await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

      // Assert: sections mapped — two sections created
      expect(result.sectionIdMap.size).toBe(2);
      expect(result.sectionIdMap.get('oldsec-1')).toBe('newsec-1');
      expect(result.sectionIdMap.get('oldsec-2')).toBe('newsec-2');

      // Assert: questions mapped — findMany returned one slot, keyed by 'respondent_name'
      expect(result.questionIdMap.size).toBe(1);
      expect(result.questionIdMap.get('oldq-1')).toBe('newq-1');

      // Assert: no tags or data slots → maps are empty
      expect(result.tagIdMap.size).toBe(0);
      expect(result.dataSlotIdMap.size).toBe(0);
    });
  });
});

// ─── Positive branches: tags with slot links and data slots with question links ─

describe('copyVersionGraph — positive branches (tags + data slots)', () => {
  let tx: ReturnType<typeof buildTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = buildTx();
  });

  /**
   * A rich source that exercises every positive (true) branch that the minimal
   * source leaves uncovered:
   *   - question with all optional fields non-null
   *   - tag with non-null color + slot links
   *   - data slot with generationConfidence non-null + question links
   */
  function richSource() {
    return {
      config: null,
      scoringSchema: null,
      tags: [
        {
          id: 'oldtag-1',
          label: 'Critical',
          normalizedLabel: 'critical',
          color: 'red', // non-null → tag.color !== null true branch
          slots: [{ questionSlotId: 'oldq-1' }], // → newSlotId found true branch
        },
      ],
      dataSlots: [
        {
          id: 'oldds-1',
          key: 'ds_name',
          name: 'Respondent name',
          description: 'Slot for the name',
          theme: 'identity',
          ordinal: 0,
          weight: 1,
          generationConfidence: 0.95, // non-null → generationConfidence true branch
          questions: [{ questionSlotId: 'oldq-1' }], // → newQuestionId found true branch
        },
      ],
      sections: [
        {
          id: 'oldsec-1',
          ordinal: 0,
          title: 'Details',
          description: 'Respondent details', // non-null → description true branch
          questions: [
            {
              id: 'oldq-1',
              ordinal: 0,
              key: 'resp_name',
              prompt: 'Name?',
              guidelines: 'Ask for full name', // non-null → guidelines true branch
              rationale: 'Required for report', // non-null → rationale true branch
              type: 'free_text',
              typeConfig: { format: 'text' }, // non-null → typeConfig true branch
              required: true,
              weight: 1,
              extractionConfidence: 0.9, // non-null → extractionConfidence true branch
            },
          ],
        },
      ],
    };
  }

  it('copies question optional fields (guidelines/rationale/typeConfig/extractionConfidence) when non-null', async () => {
    // Arrange
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(richSource());
    tx.appQuestionSlot.findMany.mockResolvedValue([{ id: 'newq-1', key: 'resp_name' }]);

    // Act
    await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: all non-null optional fields are included in the createMany payload
    const rows = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    expect(rows[0]).toMatchObject({
      guidelines: 'Ask for full name',
      rationale: 'Required for report',
      typeConfig: { format: 'text' },
      extractionConfidence: 0.9,
    });
  });

  it('copies section description when non-null', async () => {
    // Arrange
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(richSource());
    tx.appQuestionSlot.findMany.mockResolvedValue([{ id: 'newq-1', key: 'resp_name' }]);

    // Act
    await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: description is included in the section-create payload
    const sectionData = (tx.appQuestionnaireSection.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(sectionData.description).toBe('Respondent details');
  });

  it('copies tags with non-null color, links slot assignments, and calls createMany', async () => {
    // Arrange
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(richSource());
    // findMany returns the copied question slot so the assignment lookup succeeds
    tx.appQuestionSlot.findMany.mockResolvedValue([{ id: 'newq-1', key: 'resp_name' }]);
    tx.appQuestionTag.create.mockResolvedValue({ id: 'newtag-1' });

    // Act
    const result = await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: tag was created with the non-null color included
    expect(tx.appQuestionTag.create).toHaveBeenCalledTimes(1);
    const tagData = (tx.appQuestionTag.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(tagData.color).toBe('red');

    // Assert: the slot assignment was re-linked to the copied question and tag
    expect(tx.appQuestionSlotTag.createMany).toHaveBeenCalledTimes(1);
    const links = (tx.appQuestionSlotTag.createMany as Mock).mock.calls[0][0].data as Array<{
      questionSlotId: string;
      tagId: string;
    }>;
    expect(links).toEqual([{ questionSlotId: 'newq-1', tagId: 'newtag-1' }]);

    // Assert: tagIdMap maps old → new
    expect(result.tagIdMap.get('oldtag-1')).toBe('newtag-1');
  });

  it('copies data slots with generationConfidence and re-links question assignments', async () => {
    // Arrange
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue(richSource());
    tx.appQuestionSlot.findMany.mockResolvedValue([{ id: 'newq-1', key: 'resp_name' }]);
    tx.appDataSlot.create.mockResolvedValue({ id: 'newds-1' });

    // Act
    const result = await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: data slot was written with generationConfidence included
    expect(tx.appDataSlot.create).toHaveBeenCalledTimes(1);
    const dsData = (tx.appDataSlot.create as Mock).mock.calls[0][0].data as Record<string, unknown>;
    expect(dsData.generationConfidence).toBe(0.95);
    expect(dsData.versionId).toBe('tgt-v');

    // Assert: question link was re-linked via the copied question id
    expect(tx.appDataSlotQuestion.createMany).toHaveBeenCalledTimes(1);
    const dsLinks = (tx.appDataSlotQuestion.createMany as Mock).mock.calls[0][0].data as Array<{
      dataSlotId: string;
      questionSlotId: string;
    }>;
    expect(dsLinks).toEqual([{ dataSlotId: 'newds-1', questionSlotId: 'newq-1' }]);

    // Assert: dataSlotIdMap maps old → new
    expect(result.dataSlotIdMap.get('oldds-1')).toBe('newds-1');
  });
});

// ─── Additional branch: config and scoringSchema present ─────────────────────

describe('copyVersionGraph — with config and scoring schema', () => {
  let tx: ReturnType<typeof buildTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = buildTx();
    tx.appQuestionSlot.findMany.mockResolvedValue([]);
  });

  it('creates a config row when the source has one', async () => {
    // Arrange: source with config present
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      ...MINIMAL_SOURCE,
      config: {
        selectionStrategy: 'weighted',
        minQuestionsAnswered: 3,
        coverageThreshold: 0.8,
        costBudgetUsd: null,
        maxQuestionsPerSession: 20,
        voiceEnabled: false,
        contradictionMode: null,
        contradictionWindowN: null,
        anonymousMode: false,
        profileFields: null,
        inviteeFields: null,
        tone: null,
        interviewerStrategy: null,
        respondentReport: null,
        cohortReport: null,
        intro: null,
        accessMode: null,
      },
    });

    // Act
    await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: config was written into the target version
    expect(tx.appQuestionnaireConfig.create).toHaveBeenCalledTimes(1);
    const createCall = (tx.appQuestionnaireConfig.create as Mock).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // The route's code wraps JSON columns via jsonInput — the value may be
    // the wrapped input, not the raw object. Assert the versionId was bound.
    expect(createCall.data.versionId).toBe('tgt-v');
  });

  it('creates a scoring-schema row when the source has one', async () => {
    // Arrange: source with scoringSchema present
    tx.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      ...MINIMAL_SOURCE,
      scoringSchema: {
        name: 'NPS scoring',
        content: { weights: {} },
        source: 'admin',
      },
    });

    // Act
    await copyVersionGraph(tx as never, 'src-v', 'tgt-v');

    // Assert: the schema was written into the target version
    expect(tx.appScoringSchema.create).toHaveBeenCalledTimes(1);
    const schemaCall = (tx.appScoringSchema.create as Mock).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(schemaCall.data.versionId).toBe('tgt-v');
    expect(schemaCall.data.name).toBe('NPS scoring');
    expect(schemaCall.data.source).toBe('admin');
  });
});
