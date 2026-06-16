/**
 * Unit tests for the ingestion persistence writer (F1.1 / PR4, T1.4.2).
 *
 * The transaction is exercised with a mocked `executeTransaction` that invokes
 * the callback with a fake `tx`, so we assert the exact graph writes — section
 * ordinal→id mapping, slot denormalised versionId, change-record targetEntityId
 * resolution, the goal/audience merge, and that raw bytes are NOT persisted —
 * without a database. `assertPersistable` is tested as a pure guard.
 */

import { createHash } from 'node:crypto';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));

import { executeTransaction } from '@/lib/db/utils';
import {
  assertPersistable,
  briefSource,
  IncoherentExtractionError,
  persistIngestion,
  replaceVersionStructure,
  type PersistIngestionInput,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fake transaction client ──────────────────────────────────────────────────

let sectionSeq = 0;
const tx = {
  appQuestionnaire: { create: vi.fn(async () => ({ id: 'qn-1' })) },
  appQuestionnaireVersion: {
    create: vi.fn(async () => ({ id: 'ver-1' })),
    update: vi.fn(async () => ({ id: 'ver-1' })),
  },
  appQuestionnaireSection: {
    create: vi.fn(async () => ({ id: `sec-${++sectionSeq}` })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  appQuestionSlot: { createMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionnaireExtractionChange: {
    createMany: vi.fn(async () => ({ count: 0 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  appQuestionnaireSourceDocument: { create: vi.fn(async () => ({ id: 'src-1' })) },
  appQuestionTag: { deleteMany: vi.fn(async () => ({ count: 0 })) },
};

function extraction(
  overrides: Partial<ExtractQuestionnaireStructureData> = {}
): ExtractQuestionnaireStructureData {
  return {
    sections: [
      { ordinal: 0, title: 'About You' },
      { ordinal: 1, title: 'Experience', description: 'Your background' },
    ],
    questions: [
      {
        sectionOrdinal: 0,
        key: 'full_name',
        prompt: 'What is your full name?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
      {
        sectionOrdinal: 1,
        key: 'years',
        prompt: 'Years of experience?',
        suggestedType: 'numeric',
        suggestedTypeConfig: { min: 0 },
        extractionConfidence: 0.7,
      },
    ],
    changes: [],
    ...overrides,
  };
}

function input(overrides: Partial<PersistIngestionInput> = {}): PersistIngestionInput {
  return {
    documentTitle: 'Onboarding',
    extraction: extraction(),
    admin: {},
    source: {
      fileName: 'onboarding.md',
      fileHash: 'abc123',
      byteSize: 42,
      mimeType: 'text/markdown',
      warnings: [],
      extractedText: 'full text',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sectionSeq = 0;
  // Run the transaction callback against the fake tx client.
  (executeTransaction as unknown as Mock).mockImplementation((cb: (t: typeof tx) => unknown) =>
    cb(tx)
  );
});

// ─── assertPersistable ──────────────────────────────────────────────────────

describe('assertPersistable', () => {
  it('passes when every question maps to a declared section', () => {
    expect(() => assertPersistable(extraction())).not.toThrow();
  });

  it('throws IncoherentExtractionError listing orphan section ordinals', () => {
    const bad = extraction({
      questions: [
        {
          sectionOrdinal: 5,
          key: 'q',
          prompt: 'Orphaned?',
          suggestedType: 'free_text',
          extractionConfidence: 1,
        },
      ],
    });
    expect(() => assertPersistable(bad)).toThrow(IncoherentExtractionError);
    try {
      assertPersistable(bad);
    } catch (err) {
      expect((err as IncoherentExtractionError).orphanSectionOrdinals).toEqual([5]);
    }
  });
});

// ─── persistIngestion ─────────────────────────────────────────────────────────

describe('persistIngestion', () => {
  it('writes the version with merged goal/audience and returns counts + provenance', async () => {
    const result = await persistIngestion(
      input({
        extraction: extraction({
          inferredGoal: 'Collect onboarding details',
          inferredAudience: { role: 'new hire' },
        }),
        admin: { goal: 'Admin goal' },
      })
    );

    // Admin goal wins; inferred audience fills the rest. Provenance persisted per
    // field so the read surface needn't re-derive it.
    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionnaireId: 'qn-1',
          versionNumber: 1,
          status: 'draft',
          goal: 'Admin goal',
          audience: { role: 'new hire' },
          goalProvenance: 'admin-supplied',
          audienceProvenance: { role: 'inferred' },
        }),
      })
    );

    expect(result).toMatchObject({
      questionnaireId: 'qn-1',
      versionId: 'ver-1',
      sectionCount: 2,
      questionCount: 2,
      changeCount: 0,
      goal: 'Admin goal',
      audience: { role: 'new hire' },
      fieldProvenance: { goal: 'admin-supplied', audience: { role: 'inferred' } },
    });
  });

  it('attributes the questionnaire to a demo client when demoClientId is supplied', async () => {
    await persistIngestion(input({ demoClientId: 'client-1' }));

    expect(tx.appQuestionnaire.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Onboarding',
          status: 'draft',
          demoClientId: 'client-1',
        }),
      })
    );
  });

  it('omits demoClientId from the create when no attribution is supplied', async () => {
    await persistIngestion(input());

    const data = (tx.appQuestionnaire.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).not.toHaveProperty('demoClientId');
  });

  it('maps each question to its section id and denormalises versionId onto slots', async () => {
    await persistIngestion(input());

    expect(tx.appQuestionSlot.createMany).toHaveBeenCalledTimes(1);
    const data = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    expect(data).toHaveLength(2);
    // Section 0 → first created id (sec-1); section 1 → sec-2.
    expect(data[0]).toMatchObject({
      key: 'full_name',
      sectionId: 'sec-1',
      versionId: 'ver-1',
      type: 'free_text',
      ordinal: 0,
      // persistIngestion defaults to the "all required" policy (the UI checkbox is checked by default).
      required: true,
      weight: 0.5,
    });
    expect(data[1]).toMatchObject({
      key: 'years',
      sectionId: 'sec-2',
      versionId: 'ver-1',
      type: 'numeric',
      typeConfig: { min: 0 },
    });
  });

  it('resolves change-record targetEntityId to the version only for version-level changes', async () => {
    await persistIngestion(
      input({
        extraction: extraction({
          changes: [
            {
              changeType: 'infer_goal',
              targetEntityType: 'version',
              afterJson: 'A goal',
            },
            {
              changeType: 'correct_spelling',
              targetEntityType: 'question',
              beforeJson: 'adress',
              afterJson: 'address',
            },
            {
              changeType: 'prune_section',
              targetEntityType: 'section',
              beforeJson: { title: 'For office use only' },
              afterJson: null,
            },
          ],
        }),
      })
    );

    const data = (tx.appQuestionnaireExtractionChange.createMany as Mock).mock.calls[0][0]
      .data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    const inferGoal = data.find((c) => c.changeType === 'infer_goal');
    const spelling = data.find((c) => c.changeType === 'correct_spelling');
    const prune = data.find((c) => c.changeType === 'prune_section');
    expect(inferGoal?.targetEntityId).toBe('ver-1');
    expect(spelling?.targetEntityId).toBeNull();
    expect(prune?.targetEntityId).toBeNull();
    // An explicit null afterJson is written as the Prisma SQL-NULL sentinel.
    expect(prune?.afterJson).toBe(Prisma.JsonNull);
  });

  it('persists the source document text but NOT the raw bytes', async () => {
    await persistIngestion(input());

    expect(tx.appQuestionnaireSourceDocument.create).toHaveBeenCalledTimes(1);
    const data = (tx.appQuestionnaireSourceDocument.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).toMatchObject({
      versionId: 'ver-1',
      fileName: 'onboarding.md',
      fileHash: 'abc123',
      byteSize: 42,
      extractedText: 'full text',
    });
    expect(data).not.toHaveProperty('bytes');
  });

  it('skips slot/change createMany when there are no questions or changes', async () => {
    await persistIngestion(input({ extraction: extraction({ questions: [], changes: [] }) }));
    expect(tx.appQuestionSlot.createMany).not.toHaveBeenCalled();
    expect(tx.appQuestionnaireExtractionChange.createMany).not.toHaveBeenCalled();
  });

  it('writes a null goal and SQL-NULL audience when nothing supplies them', async () => {
    // No admin metadata, no inferred goal/audience → both fields fall to null.
    const result = await persistIngestion(input({ admin: {} }));

    expect(tx.appQuestionnaireVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goal: null,
          audience: Prisma.JsonNull,
          // Nothing resolved → null goal provenance, SQL-NULL audience provenance.
          goalProvenance: null,
          audienceProvenance: Prisma.JsonNull,
        }),
      })
    );
    expect(result.goal).toBeNull();
    expect(result.audience).toBeNull();
    expect(result.fieldProvenance).toEqual({ audience: {} });
  });

  it('records source pageCount and omits mimeType when only pageCount is supplied', async () => {
    await persistIngestion(
      input({
        source: {
          fileName: 'scan.pdf',
          fileHash: 'hash-pdf',
          byteSize: 1024,
          pageCount: 3,
          warnings: ['ocr fallback'],
          extractedText: 'text',
          // no mimeType
        },
      })
    );

    const data = (tx.appQuestionnaireSourceDocument.create as Mock).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data.pageCount).toBe(3);
    expect(data).not.toHaveProperty('mimeType');
    // Non-empty warnings are stored (not the SQL-NULL sentinel).
    expect(data.warnings).toEqual(['ocr fallback']);
  });

  it('includes guidelines and rationale on a slot when the question supplies them', async () => {
    // This covers the true-branch of the guidelines/rationale optional spreads (lines 159-160).
    await persistIngestion(
      input({
        extraction: extraction({
          sections: [{ ordinal: 0, title: 'S' }],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'guided_q',
              prompt: 'Describe your role.',
              suggestedType: 'free_text',
              extractionConfidence: 0.85,
              guidelines: 'Be specific about seniority.',
              rationale: 'Helps segment responses by level.',
            },
          ],
          changes: [],
        }),
      })
    );

    const data = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    // Assert that the CODE spread the optional fields from the question — not just
    // that createMany was called with some data.
    expect(data[0]).toMatchObject({
      key: 'guided_q',
      guidelines: 'Be specific about seniority.',
      rationale: 'Helps segment responses by level.',
    });
  });

  it('omits afterJson from a change record when the change has no afterJson', async () => {
    // Covers the false-branch of the afterJson ternary (line 183): when a change only
    // has beforeJson (e.g. a prune with no after-value), afterJson must not appear.
    await persistIngestion(
      input({
        extraction: extraction({
          changes: [
            {
              changeType: 'prune_question',
              targetEntityType: 'question',
              beforeJson: 'old prompt',
              // no afterJson
            },
          ],
        }),
      })
    );

    const data = (tx.appQuestionnaireExtractionChange.createMany as Mock).mock.calls[0][0]
      .data as Array<Record<string, unknown>>;
    // The code should NOT include an afterJson key when the change omits it.
    expect(data[0]).not.toHaveProperty('afterJson');
    expect(data[0].beforeJson).toBe('old prompt');
  });

  it('carries optional change-record provenance fields when present', async () => {
    await persistIngestion(
      input({
        extraction: extraction({
          changes: [
            {
              changeType: 'rewrite_prompt',
              targetEntityType: 'question',
              beforeJson: 'terse',
              afterJson: 'a clearer prompt',
              sourceQuote: 'terse',
              rationale: 'Clarified the ask.',
              confidence: 0.8,
            },
          ],
        }),
      })
    );

    const data = (tx.appQuestionnaireExtractionChange.createMany as Mock).mock.calls[0][0]
      .data as Array<Record<string, unknown>>;
    expect(data[0]).toMatchObject({
      changeType: 'rewrite_prompt',
      sourceQuote: 'terse',
      rationale: 'Clarified the ask.',
      confidence: 0.8,
      beforeJson: 'terse',
      afterJson: 'a clearer prompt',
    });
  });
});

// ─── requiredness policy ──────────────────────────────────────────────────────

describe('persistIngestion requiredness policy', () => {
  /** Read the `required` flags off the slot createMany call, in slot order. */
  function writtenRequired(): boolean[] {
    const data = (tx.appQuestionSlot.createMany as Mock).mock.calls[0][0].data as Array<
      Record<string, unknown>
    >;
    return data.map((d) => d.required as boolean);
  }

  it("defaults to 'all' — every slot required — when requiredness is omitted", async () => {
    await persistIngestion(input());
    expect(writtenRequired()).toEqual([true, true]);
  });

  it("'optional' writes every slot as not required, ignoring the source flag", async () => {
    await persistIngestion(
      input({
        requiredness: 'optional',
        extraction: extraction({
          questions: [
            {
              sectionOrdinal: 0,
              key: 'a',
              prompt: 'A?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
              required: true, // even a source-required question is forced optional
            },
          ],
        }),
      })
    );
    expect(writtenRequired()).toEqual([false]);
  });

  it("'source' honours each question's extracted required flag (missing ⇒ false)", async () => {
    await persistIngestion(
      input({
        requiredness: 'source',
        extraction: extraction({
          sections: [{ ordinal: 0, title: 'S' }],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'marked',
              prompt: 'Marked required?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
              required: true,
            },
            {
              sectionOrdinal: 0,
              key: 'unmarked',
              prompt: 'Not marked?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
              // no `required` ⇒ falls back to false
            },
          ],
        }),
      })
    );
    expect(writtenRequired()).toEqual([true, false]);
  });

  it("'all' forces required true even when the source omits or denies it", async () => {
    await persistIngestion(
      input({
        requiredness: 'all',
        extraction: extraction({
          sections: [{ ordinal: 0, title: 'S' }],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'unmarked',
              prompt: 'Not marked?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
            },
          ],
        }),
      })
    );
    expect(writtenRequired()).toEqual([true]);
  });
});

// ─── briefSource ─────────────────────────────────────────────────────────────

describe('briefSource', () => {
  it('returns fileName brief.txt with mimeType text/plain and empty warnings', () => {
    const source = briefSource('Tell me about onboarding.');

    // Verify the static fields the function sets — not just that a mock returned them.
    expect(source.fileName).toBe('brief.txt');
    expect(source.mimeType).toBe('text/plain');
    expect(source.warnings).toEqual([]);
  });

  it('uses the brief text as extractedText so re-ingest diff has a source to compare', () => {
    const brief = 'I need a customer-satisfaction questionnaire with 10 questions.';
    const source = briefSource(brief);

    expect(source.extractedText).toBe(brief);
  });

  it('sets byteSize to the UTF-8 byte length of the brief', () => {
    const brief = 'hello'; // 5 ASCII bytes
    const source = briefSource(brief);

    expect(source.byteSize).toBe(Buffer.byteLength(brief, 'utf8'));
  });

  it('sets fileHash to the SHA-256 hex digest of the brief', () => {
    const brief = 'my brief text';
    const expected = createHash('sha256').update(brief).digest('hex');
    const source = briefSource(brief);

    // briefSource must COMPUTE the hash from the input — not return an
    // arbitrary value — so the assertion checks the exact transformation.
    expect(source.fileHash).toBe(expected);
    expect(source.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different briefs (hash is over the brief content)', () => {
    const s1 = briefSource('Brief A');
    const s2 = briefSource('Brief B');

    expect(s1.fileHash).not.toBe(s2.fileHash);
  });

  it('produces different byteSizes for different-length briefs', () => {
    const short = briefSource('x');
    const long = briefSource('x'.repeat(100));

    expect(short.byteSize).toBeLessThan(long.byteSize);
  });
});

// ─── replaceVersionStructure ──────────────────────────────────────────────────

describe('replaceVersionStructure', () => {
  it('clears the prior graph before writing the new one', async () => {
    // Arrange: a fresh extraction with 1 section and 1 question.
    const freshExtraction = extraction({
      sections: [{ ordinal: 0, title: 'New Section' }],
      questions: [
        {
          sectionOrdinal: 0,
          key: 'q1',
          prompt: 'Refined question?',
          suggestedType: 'free_text',
          extractionConfidence: 0.95,
        },
      ],
      changes: [],
    });

    await replaceVersionStructure('ver-replace-1', freshExtraction);

    // Assert: all three delete operations ran before the new graph was written.
    expect(tx.appQuestionnaireExtractionChange.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-replace-1' },
    });
    expect(tx.appQuestionnaireSection.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-replace-1' },
    });
    expect(tx.appQuestionTag.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-replace-1' },
    });
  });

  it('returns structural counts from the freshly-written graph', async () => {
    const freshExtraction = extraction({
      sections: [
        { ordinal: 0, title: 'S1' },
        { ordinal: 1, title: 'S2' },
      ],
      questions: [
        {
          sectionOrdinal: 0,
          key: 'q1',
          prompt: 'Q1?',
          suggestedType: 'free_text',
          extractionConfidence: 1,
        },
        {
          sectionOrdinal: 1,
          key: 'q2',
          prompt: 'Q2?',
          suggestedType: 'numeric',
          extractionConfidence: 0.8,
        },
        {
          sectionOrdinal: 1,
          key: 'q3',
          prompt: 'Q3?',
          suggestedType: 'boolean',
          extractionConfidence: 0.9,
        },
      ],
      changes: [{ changeType: 'rewrite_prompt', targetEntityType: 'question', afterJson: 'new' }],
    });

    const counts = await replaceVersionStructure('ver-replace-2', freshExtraction);

    // Counts reflect the NEW graph, not the cleared one — the function must
    // pass through writeGraph's output, not the deleteMany counts.
    expect(counts).toEqual({ sectionCount: 2, questionCount: 3, changeCount: 1 });
  });

  it('updates the version goal/audience when the refined extraction supplies them', async () => {
    const freshExtraction = extraction({
      inferredGoal: 'Refined goal',
      inferredAudience: { role: 'senior engineer' },
    });

    await replaceVersionStructure('ver-replace-3', freshExtraction);

    expect(tx.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ver-replace-3' },
        data: expect.objectContaining({
          goal: 'Refined goal',
          // audience passes through jsonInput — the raw object is an InputJsonValue
          audience: { role: 'senior engineer' },
        }),
      })
    );
  });

  it('does NOT update the version when the refined extraction omits goal and audience', async () => {
    // Extraction without inferredGoal/inferredAudience — existing DB values stay.
    const freshExtraction = extraction({
      sections: [{ ordinal: 0, title: 'S' }],
      questions: [],
      changes: [],
    });
    // Strip the inferred fields to make this explicit.
    delete (freshExtraction as Partial<ExtractQuestionnaireStructureData>).inferredGoal;
    delete (freshExtraction as Partial<ExtractQuestionnaireStructureData>).inferredAudience;

    await replaceVersionStructure('ver-replace-4', freshExtraction);

    // No update call should fire — the `data` object was empty, so the branch was skipped.
    expect(tx.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });
});
