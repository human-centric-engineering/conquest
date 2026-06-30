/**
 * Unit tests for the definition-import persister (F14.9).
 *
 * The transaction is exercised with a mocked `executeTransaction` that invokes
 * the callback with a fake `tx`, so we assert the exact graph writes — questionnaire
 * + version creation, tag deduplication by normalised label, question-key collision
 * handling, question→tag and data-slot→question link resolution, config row creation,
 * and scoring schema attribution — without a database.
 *
 * Writes are BATCHED to keep the transaction inside the interactive-transaction budget
 * under production DB latency (the per-row variant timed out on prod, P2028): tags,
 * sections, questions, and data slots each go through one `createManyAndReturn`, and the
 * link tables through one `createMany`. The fake `tx` therefore returns rows keyed by the
 * same unique field (normalisedLabel / ordinal / key) the persister maps them back by, and
 * the fakes return rows in a DELIBERATELY SHUFFLED order to prove the persister matches by
 * key, not by array position.
 *
 * Pattern mirrors `persist.test.ts`: `executeTransaction` is mocked at the top,
 * and a module-level `tx` object with key-derived id factories drives assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));

import { executeTransaction } from '@/lib/db/utils';
import {
  persistDefinitionImport,
  type ImportDefinitionInput,
} from '@/app/api/v1/app/questionnaires/_lib/import-definition';
import {
  DEFINITION_EXPORT_KIND,
  DEFINITION_EXPORT_SCHEMA_VERSION,
  type DefinitionImport,
} from '@/lib/app/questionnaire/authoring';

type Mock = ReturnType<typeof vi.fn>;
type Row = Record<string, unknown>;

/** Reverse a copy of the returned rows so tests can't accidentally rely on input order. */
function shuffled<T>(rows: T[]): T[] {
  return [...rows].reverse();
}

// ─── Fake transaction client ──────────────────────────────────────────────────
//
// Batched creators derive a stable id from the row's unique key and return rows shuffled,
// forcing the persister to resolve ids by key/ordinal/normalisedLabel rather than position.

const tx = {
  appQuestionnaire: { create: vi.fn(async () => ({ id: 'qn-1' })) },
  appQuestionnaireVersion: { create: vi.fn(async () => ({ id: 'ver-1' })) },
  appQuestionTag: {
    createManyAndReturn: vi.fn(async ({ data }: { data: Row[] }) =>
      shuffled(
        data.map((row) => ({
          id: `tag-${String(row.normalizedLabel)}`,
          normalizedLabel: row.normalizedLabel,
        }))
      )
    ),
  },
  appQuestionnaireSection: {
    createManyAndReturn: vi.fn(async ({ data }: { data: Row[] }) =>
      shuffled(data.map((row) => ({ id: `sec-${String(row.ordinal)}`, ordinal: row.ordinal })))
    ),
  },
  appQuestionSlot: {
    createManyAndReturn: vi.fn(async ({ data }: { data: Row[] }) =>
      shuffled(data.map((row) => ({ id: `q-${String(row.key)}`, key: row.key })))
    ),
  },
  appQuestionSlotTag: { createMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionnaireConfig: { create: vi.fn(async () => ({ id: 'cfg-1' })) },
  appDataSlot: {
    createManyAndReturn: vi.fn(async ({ data }: { data: Row[] }) =>
      shuffled(data.map((row) => ({ id: `slot-${String(row.key)}`, key: row.key })))
    ),
  },
  appDataSlotQuestion: { createMany: vi.fn(async () => ({ count: 0 })) },
  appScoringSchema: { create: vi.fn(async () => ({ id: 'schema-1' })) },
};

/** The single `data` array passed to a batched creator's first call. */
function batchData(creator: Mock): Row[] {
  return creator.mock.calls[0][0].data as Row[];
}

// ─── Test envelope builder ────────────────────────────────────────────────────

function makeEnvelope(
  versionOverrides: Partial<DefinitionImport['version']> = {}
): DefinitionImport {
  return {
    kind: DEFINITION_EXPORT_KIND,
    schemaVersion: DEFINITION_EXPORT_SCHEMA_VERSION,
    questionnaire: { title: 'Onboarding Survey' },
    version: {
      goal: null,
      audience: null,
      tags: [],
      sections: [
        {
          ordinal: 0,
          title: 'About You',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'full_name',
              prompt: 'What is your full name?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
      ],
      dataSlots: [],
      ...versionOverrides,
    },
  };
}

function input(overrides: Partial<ImportDefinitionInput> = {}): ImportDefinitionInput {
  return {
    envelope: makeEnvelope(),
    adminId: 'admin-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Run the transaction callback against the fake tx client.
  (executeTransaction as unknown as Mock).mockImplementation((cb: (t: typeof tx) => unknown) =>
    cb(tx)
  );
});

// ─── persistDefinitionImport ─────────────────────────────────────────────────

describe('persistDefinitionImport', () => {
  it('runs inside a transaction with extended timeout headroom over the 5s default', async () => {
    await persistDefinitionImport(input());

    // The per-row variant timed out on prod (P2028); the persister now asks for more than the
    // 5000ms interactive-transaction default so a large import has headroom under prod latency.
    const options = (executeTransaction as unknown as Mock).mock.calls[0][1] as
      | { timeout?: number; maxWait?: number }
      | undefined;
    expect(options?.timeout).toBeGreaterThan(5000);
    expect(options?.maxWait).toBeGreaterThan(2000);
  });

  it('creates a draft questionnaire and v1 draft version, wiring the FK from the DB response', async () => {
    const result = await persistDefinitionImport(input());

    // Questionnaire row: title from envelope, status hard-coded to 'draft'.
    expect(tx.appQuestionnaire.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: 'Onboarding Survey', status: 'draft' }),
      })
    );

    // Version row: FK wired to the id returned by the questionnaire create, not hardcoded.
    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionnaireId: 'qn-1', // derived from the questionnaire create response
          versionNumber: 1,
          status: 'draft',
        }),
      })
    );

    // Return values are threaded from the DB responses, not independently generated.
    expect(result.questionnaireId).toBe('qn-1');
    expect(result.versionId).toBe('ver-1');
  });

  it('sets goalProvenance to admin-supplied when goal is present', async () => {
    await persistDefinitionImport(
      input({ envelope: makeEnvelope({ goal: 'Understand churn drivers' }) })
    );

    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goal: 'Understand churn drivers',
          goalProvenance: 'admin-supplied',
        }),
      })
    );
  });

  it('sets goalProvenance to null when goal is absent', async () => {
    await persistDefinitionImport(input({ envelope: makeEnvelope({ goal: null }) }));

    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ goal: null, goalProvenance: null }),
      })
    );
  });

  it('sets audienceProvenance to admin-supplied for each present audience field', async () => {
    const envelope = makeEnvelope({
      audience: { role: 'Software Engineer', expertiseLevel: 'intermediate' },
    });
    await persistDefinitionImport(input({ envelope }));

    // Only the fields that are present in the audience object appear in audienceProvenance.
    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audience: { role: 'Software Engineer', expertiseLevel: 'intermediate' },
          audienceProvenance: { role: 'admin-supplied', expertiseLevel: 'admin-supplied' },
        }),
      })
    );
  });

  it('writes Prisma.JsonNull for audience and audienceProvenance when audience is null', async () => {
    // audience: null → both JSON columns written as SQL-NULL sentinel.
    await persistDefinitionImport(input({ envelope: makeEnvelope({ audience: null }) }));

    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audience: Prisma.JsonNull,
          audienceProvenance: Prisma.JsonNull,
        }),
      })
    );
  });

  it('mints one tag row per unique normalised label and collapses case duplicates', async () => {
    // 'Skills' and 'skills' normalise to the same label → only one row is created.
    const envelope = makeEnvelope({
      tags: [
        { label: 'Skills', color: null },
        { label: 'skills', color: 'blue' }, // duplicate normalised label — skipped
        { label: 'Background', color: 'red' },
      ],
      sections: [{ ordinal: 0, title: 'S', description: null, questions: [] }],
    });
    const result = await persistDefinitionImport(input({ envelope }));

    // One batched write of two deduped rows (not three).
    expect(tx.appQuestionTag.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(batchData(tx.appQuestionTag.createManyAndReturn as Mock)).toHaveLength(2);
    expect(result.tagCount).toBe(2);
  });

  it('omits color from a tag row when the tag color is null', async () => {
    const envelope = makeEnvelope({
      tags: [{ label: 'Plain Tag', color: null }],
      sections: [{ ordinal: 0, title: 'S', description: null, questions: [] }],
    });
    await persistDefinitionImport(input({ envelope }));

    const tagRow = batchData(tx.appQuestionTag.createManyAndReturn as Mock)[0];
    // The persister conditionally spreads color; null must not produce a key.
    expect(tagRow.label).toBe('Plain Tag');
    expect(tagRow).not.toHaveProperty('color');
  });

  it('does not write tags when the envelope has none', async () => {
    await persistDefinitionImport(input({ envelope: makeEnvelope({ tags: [] }) }));

    expect(tx.appQuestionTag.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('creates sections and questions with full field fidelity, wiring sectionIds correctly', async () => {
    const envelope = makeEnvelope({
      sections: [
        {
          ordinal: 0,
          title: 'Section A',
          description: 'Background context',
          questions: [
            {
              ordinal: 0,
              key: 'full_name',
              prompt: 'Full name?',
              guidelines: 'Use legal name',
              rationale: 'For records',
              type: 'free_text',
              typeConfig: undefined,
              required: true,
              weight: 1.5,
              tagLabels: [],
            },
          ],
        },
        {
          ordinal: 1,
          title: 'Section B',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'years_exp',
              prompt: 'Years of experience?',
              guidelines: null,
              rationale: null,
              type: 'numeric',
              typeConfig: { min: 0, max: 50 },
              required: false,
              weight: 0.5,
              tagLabels: [],
            },
          ],
        },
      ],
    });
    const result = await persistDefinitionImport(input({ envelope }));

    // Both sections in one batch.
    expect(tx.appQuestionnaireSection.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(batchData(tx.appQuestionnaireSection.createManyAndReturn as Mock)).toHaveLength(2);

    // Both questions in one batch; each wired to its section id (resolved by ordinal, not
    // array position — the section fake returns rows shuffled) and carrying its optional fields.
    const questionRows = batchData(tx.appQuestionSlot.createManyAndReturn as Mock);
    expect(questionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionId: 'ver-1',
          sectionId: 'sec-0', // resolved from the section whose ordinal is 0
          key: 'full_name',
          prompt: 'Full name?',
          type: 'free_text',
          required: true,
          weight: 1.5,
          guidelines: 'Use legal name',
          rationale: 'For records',
        }),
        expect.objectContaining({
          sectionId: 'sec-1', // resolved from the section whose ordinal is 1
          key: 'years_exp',
          type: 'numeric',
          required: false,
          typeConfig: { min: 0, max: 50 },
        }),
      ])
    );

    expect(result).toMatchObject({ sectionCount: 2, questionCount: 2 });
  });

  it('assigns globally increasing question ordinals across sections', async () => {
    const envelope = makeEnvelope({
      sections: [
        {
          ordinal: 0,
          title: 'S1',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'a',
              prompt: 'A?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
        {
          ordinal: 1,
          title: 'S2',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'b',
              prompt: 'B?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
      ],
    });
    await persistDefinitionImport(input({ envelope }));

    const rows = batchData(tx.appQuestionSlot.createManyAndReturn as Mock);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.ordinal]));
    // The second section's question continues the global counter (1), not restart at 0.
    expect(byKey).toEqual({ a: 0, b: 1 });
  });

  it('deduplicates colliding question keys and data-slot refs resolve through the original key', async () => {
    // Two questions share the same original key 'score'. The persister assigns 'score' to the first
    // and 'score_2' to the second (via nextAvailableKey). The original-key map is keyed by q.key
    // (not the stored key), so a data slot referencing 'score' resolves to whatever the map holds
    // after processing all questions.
    const envelope = makeEnvelope({
      sections: [
        {
          ordinal: 0,
          title: 'Scores',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'score',
              prompt: 'First score question?',
              guidelines: null,
              rationale: null,
              type: 'numeric',
              required: true,
              weight: 1,
              tagLabels: [],
            },
            {
              ordinal: 1,
              key: 'score',
              prompt: 'Second score question?',
              guidelines: null,
              rationale: null,
              type: 'numeric',
              required: false,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
      ],
      dataSlots: [
        {
          key: 'score_slot',
          name: 'Score',
          description: 'Combined scores',
          theme: 'performance',
          ordinal: 0,
          weight: 1,
          questionKeys: ['score'],
        },
      ],
    });

    await persistDefinitionImport(input({ envelope }));

    // First question stored with original key; second gets a deduplicated suffix.
    const keys = batchData(tx.appQuestionSlot.createManyAndReturn as Mock).map((r) => r.key);
    expect(keys).toEqual(['score', 'score_2']);

    // Data-slot mapping resolves 'score' through the original-key map. Both questions wrote
    // q.key='score'; the deduped keys map back to the same original, last write wins → q-score_2.
    expect(tx.appDataSlotQuestion.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ dataSlotId: 'slot-score_slot', questionSlotId: 'q-score_2' }),
        ],
      })
    );
  });

  it('resolves question→tag links through the remapped vocabulary and skips unknown labels', async () => {
    const envelope = makeEnvelope({
      tags: [{ label: 'Background', color: null }],
      sections: [
        {
          ordinal: 0,
          title: 'S',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'bio',
              prompt: 'Tell us about yourself.',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              // 'Background' resolves; 'NonExistent' has no tag row → skipped.
              tagLabels: ['Background', 'NonExistent'],
            },
          ],
        },
      ],
    });
    await persistDefinitionImport(input({ envelope }));

    // Exactly one link: 'Background' → tag-background. 'NonExistent' produced no entry.
    expect(tx.appQuestionSlotTag.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ questionSlotId: 'q-bio', tagId: 'tag-background' }],
      })
    );
    expect(batchData(tx.appQuestionSlotTag.createMany as Mock)).toHaveLength(1);
  });

  it('batches question→tag links across every question into a single createMany', async () => {
    const envelope = makeEnvelope({
      tags: [
        { label: 'Alpha', color: null },
        { label: 'Beta', color: null },
      ],
      sections: [
        {
          ordinal: 0,
          title: 'S',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'q1',
              prompt: 'Q1?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: ['Alpha'],
            },
            {
              ordinal: 1,
              key: 'q2',
              prompt: 'Q2?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: ['Beta'],
            },
          ],
        },
      ],
    });
    await persistDefinitionImport(input({ envelope }));

    // One call, both links — not one createMany per question.
    expect(tx.appQuestionSlotTag.createMany).toHaveBeenCalledTimes(1);
    expect(batchData(tx.appQuestionSlotTag.createMany as Mock)).toEqual(
      expect.arrayContaining([
        { questionSlotId: 'q-q1', tagId: 'tag-alpha' },
        { questionSlotId: 'q-q2', tagId: 'tag-beta' },
      ])
    );
  });

  it('does not call createMany for question tags when no tag labels resolve', async () => {
    // Question references only labels that have no matching tag row.
    const envelope = makeEnvelope({
      tags: [],
      sections: [
        {
          ordinal: 0,
          title: 'S',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'q',
              prompt: 'Q?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: ['GhostTag'],
            },
          ],
        },
      ],
    });
    await persistDefinitionImport(input({ envelope }));

    expect(tx.appQuestionSlotTag.createMany).not.toHaveBeenCalled();
  });

  it('creates the config row when version.config is present and wires the versionId', async () => {
    const envelope = makeEnvelope({
      config: { voiceEnabled: true, maxQuestionsPerSession: 5 },
    });
    await persistDefinitionImport(input({ envelope }));

    expect(tx.appQuestionnaireConfig.create).toHaveBeenCalledTimes(1);
    const configData = (tx.appQuestionnaireConfig.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // versionId threaded from the version create response.
    expect(configData.versionId).toBe('ver-1');
    // Scalar fields spread directly — not wrapped or omitted.
    expect(configData.voiceEnabled).toBe(true);
    expect(configData.maxQuestionsPerSession).toBe(5);
  });

  it('does not create a config row when version.config is absent', async () => {
    const envelope = makeEnvelope({ config: undefined });
    await persistDefinitionImport(input({ envelope }));

    expect(tx.appQuestionnaireConfig.create).not.toHaveBeenCalled();
  });

  it('creates data slots and links only question keys present in the import', async () => {
    const envelope = makeEnvelope({
      sections: [
        {
          ordinal: 0,
          title: 'S',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'experience',
              prompt: 'Years of experience?',
              guidelines: null,
              rationale: null,
              type: 'numeric',
              required: true,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
      ],
      dataSlots: [
        {
          key: 'exp_slot',
          name: 'Experience',
          description: 'Years in field',
          theme: 'background',
          ordinal: 0,
          weight: 1,
          // 'experience' resolves; 'ghost_key' has no question row → skipped.
          questionKeys: ['experience', 'ghost_key'],
        },
      ],
    });
    const result = await persistDefinitionImport(input({ envelope }));

    expect(tx.appDataSlot.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(batchData(tx.appDataSlot.createManyAndReturn as Mock)).toHaveLength(1);
    expect(result.dataSlotCount).toBe(1);

    // 'experience' → q-experience; 'ghost_key' produced no mapping.
    expect(tx.appDataSlotQuestion.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ dataSlotId: 'slot-exp_slot', questionSlotId: 'q-experience' }],
      })
    );
    expect(batchData(tx.appDataSlotQuestion.createMany as Mock)).toHaveLength(1);
  });

  it('does not call createMany for data-slot questions when all question keys are unknown', async () => {
    const envelope = makeEnvelope({
      sections: [{ ordinal: 0, title: 'S', description: null, questions: [] }],
      dataSlots: [
        {
          key: 'orphan',
          name: 'Orphan',
          description: '',
          theme: 'misc',
          ordinal: 0,
          weight: 1,
          questionKeys: ['no_such_key'],
        },
      ],
    });
    await persistDefinitionImport(input({ envelope }));

    // The slot itself is still written; only the (empty) link batch is skipped.
    expect(tx.appDataSlot.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.appDataSlotQuestion.createMany).not.toHaveBeenCalled();
  });

  it('creates the scoring schema with source manual and createdBy equal to adminId', async () => {
    const envelope = makeEnvelope({
      scoringSchema: {
        name: 'Overall Score',
        content: { scales: [], items: [], bands: [], method: 'mean' },
      },
    });
    await persistDefinitionImport(input({ envelope, adminId: 'admin-99' }));

    expect(tx.appScoringSchema.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionId: 'ver-1',
          name: 'Overall Score',
          source: 'manual',
          createdBy: 'admin-99', // threaded from the input, not hardcoded
        }),
      })
    );
  });

  it('does not create a scoring schema when version.scoringSchema is absent', async () => {
    const envelope = makeEnvelope({ scoringSchema: undefined });
    await persistDefinitionImport(input({ envelope }));

    expect(tx.appScoringSchema.create).not.toHaveBeenCalled();
  });

  it('returns correct structural counts that reflect the written graph', async () => {
    const envelope = makeEnvelope({
      tags: [
        { label: 'Alpha', color: null },
        { label: 'Beta', color: null },
      ],
      sections: [
        {
          ordinal: 0,
          title: 'S1',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'q1',
              prompt: 'Q1?',
              guidelines: null,
              rationale: null,
              type: 'free_text',
              required: true,
              weight: 1,
              tagLabels: [],
            },
            {
              ordinal: 1,
              key: 'q2',
              prompt: 'Q2?',
              guidelines: null,
              rationale: null,
              type: 'boolean',
              required: false,
              weight: 0.5,
              tagLabels: [],
            },
          ],
        },
        {
          ordinal: 1,
          title: 'S2',
          description: null,
          questions: [
            {
              ordinal: 0,
              key: 'q3',
              prompt: 'Q3?',
              guidelines: null,
              rationale: null,
              type: 'numeric',
              required: true,
              weight: 1,
              tagLabels: [],
            },
          ],
        },
      ],
      dataSlots: [
        {
          key: 'ds1',
          name: 'DS1',
          description: '',
          theme: 'x',
          ordinal: 0,
          weight: 1,
          questionKeys: [],
        },
        {
          key: 'ds2',
          name: 'DS2',
          description: '',
          theme: 'y',
          ordinal: 1,
          weight: 1,
          questionKeys: [],
        },
      ],
    });
    const result = await persistDefinitionImport(input({ envelope }));

    // Counts must reflect the actual graph written, not the mock return values.
    expect(result).toMatchObject({
      sectionCount: 2,
      questionCount: 3,
      tagCount: 2,
      dataSlotCount: 2,
    });
  });

  it('attaches demoClientId to the questionnaire row when provided', async () => {
    await persistDefinitionImport(input({ demoClientId: 'demo-client-42' }));

    expect(tx.appQuestionnaire.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ demoClientId: 'demo-client-42' }),
      })
    );
  });

  it('omits demoClientId from the questionnaire row when not provided', async () => {
    await persistDefinitionImport(input());

    const questionnaireData = (tx.appQuestionnaire.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(questionnaireData).not.toHaveProperty('demoClientId');
  });
});
