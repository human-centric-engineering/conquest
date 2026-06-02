/**
 * Unit tests for the ingestion persistence writer (F1.1 / PR4, T1.4.2).
 *
 * The transaction is exercised with a mocked `executeTransaction` that invokes
 * the callback with a fake `tx`, so we assert the exact graph writes — section
 * ordinal→id mapping, slot denormalised versionId, change-record targetEntityId
 * resolution, the goal/audience merge, and that raw bytes are NOT persisted —
 * without a database. `assertPersistable` is tested as a pure guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));

import { executeTransaction } from '@/lib/db/utils';
import {
  assertPersistable,
  IncoherentExtractionError,
  persistIngestion,
  type PersistIngestionInput,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fake transaction client ──────────────────────────────────────────────────

let sectionSeq = 0;
const tx = {
  appQuestionnaire: { create: vi.fn(async () => ({ id: 'qn-1' })) },
  appQuestionnaireVersion: { create: vi.fn(async () => ({ id: 'ver-1' })) },
  appQuestionnaireSection: {
    create: vi.fn(async () => ({ id: `sec-${++sectionSeq}` })),
  },
  appQuestionSlot: { createMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionnaireExtractionChange: { createMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionnaireSourceDocument: { create: vi.fn(async () => ({ id: 'src-1' })) },
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
      required: false,
      weight: 1.0,
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
