/**
 * Unit tests for the re-ingest persistence writer (F2.4).
 *
 * The transaction is exercised with a mocked `executeTransaction` that invokes
 * the callback with a fake `tx` (the real `writeGraph` / `writeSourceDocument`
 * from persist.ts run against it), so we assert the destructive replace without a
 * database: the current goal/audience is read, the prior change log + sections +
 * tag vocabulary are deleted (scoped to the version), the version row is updated
 * with the re-merged goal/audience, the new graph + source doc are written, and
 * the pre-existing merge arm keeps a field the new extraction doesn't re-supply.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/utils', () => ({ executeTransaction: vi.fn() }));

import { executeTransaction } from '@/lib/db/utils';
import {
  reingestVersion,
  ReingestNotDraftError,
} from '@/app/api/v1/app/questionnaires/_lib/reingest';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fake transaction client ──────────────────────────────────────────────────

let sectionSeq = 0;
let current = { status: 'draft', goal: null as string | null, audience: null as unknown };
const tx = {
  appQuestionnaireVersion: {
    findUniqueOrThrow: vi.fn(async () => current),
    update: vi.fn(async () => ({ id: 'ver-1' })),
  },
  appQuestionnaireExtractionChange: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  appQuestionnaireSection: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async () => ({ id: `sec-${++sectionSeq}` })),
  },
  appQuestionTag: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionSlot: { createMany: vi.fn(async () => ({ count: 0 })) },
  appQuestionnaireSourceDocument: { create: vi.fn(async () => ({ id: 'src-1' })) },
};

function extraction(
  overrides: Partial<ExtractQuestionnaireStructureData> = {}
): ExtractQuestionnaireStructureData {
  return {
    sections: [{ ordinal: 0, title: 'About You' }],
    questions: [
      {
        sectionOrdinal: 0,
        key: 'name',
        prompt: 'Your name?',
        suggestedType: 'free_text',
        extractionConfidence: 0.9,
      },
    ],
    inferredGoal: 'Fresh goal',
    changes: [{ changeType: 'infer_goal', targetEntityType: 'version', afterJson: 'Fresh goal' }],
    ...overrides,
  };
}

const source = {
  fileName: 'v2.md',
  fileHash: 'abc123',
  byteSize: 42,
  warnings: [],
  extractedText: '# Form',
};

beforeEach(() => {
  vi.clearAllMocks();
  sectionSeq = 0;
  current = { status: 'draft', goal: null, audience: null };
  (executeTransaction as Mock).mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx));
});

describe('reingestVersion — destructive replace', () => {
  it('clears the prior change log, sections, and tag vocabulary scoped to the version', async () => {
    await reingestVersion({ versionId: 'ver-1', extraction: extraction(), admin: {}, source });

    expect(tx.appQuestionnaireExtractionChange.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-1' },
    });
    expect(tx.appQuestionnaireSection.deleteMany).toHaveBeenCalledWith({
      where: { versionId: 'ver-1' },
    });
    expect(tx.appQuestionTag.deleteMany).toHaveBeenCalledWith({ where: { versionId: 'ver-1' } });
  });

  it('deletes the prior graph before writing the new one', async () => {
    await reingestVersion({ versionId: 'ver-1', extraction: extraction(), admin: {}, source });

    // The section delete must precede the first section create (global call order).
    const deleteOrder = (tx.appQuestionnaireSection.deleteMany as Mock).mock.invocationCallOrder[0];
    const createOrder = (tx.appQuestionnaireSection.create as Mock).mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('writes the new graph and appends the new source document', async () => {
    await reingestVersion({ versionId: 'ver-1', extraction: extraction(), admin: {}, source });

    expect(tx.appQuestionnaireSection.create).toHaveBeenCalledTimes(1);
    expect(tx.appQuestionSlot.createMany).toHaveBeenCalledTimes(1);
    expect(tx.appQuestionnaireExtractionChange.createMany).toHaveBeenCalledTimes(1);
    expect(tx.appQuestionnaireSourceDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ versionId: 'ver-1', fileHash: 'abc123' }),
      })
    );
  });

  it('keeps the version id/number/status — only goal/audience are updated', async () => {
    await reingestVersion({ versionId: 'ver-1', extraction: extraction(), admin: {}, source });

    const updateArg = (tx.appQuestionnaireVersion.update as Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'ver-1' });
    expect(updateArg.data).not.toHaveProperty('status');
    expect(updateArg.data).not.toHaveProperty('versionNumber');
    expect(updateArg.data.goal).toBe('Fresh goal');
  });

  it('re-asserts draft status inside the transaction and aborts without deleting if launched', async () => {
    // The version was launched after the route's pre-check (TOCTOU).
    current = { status: 'launched', goal: null, audience: null };

    await expect(
      reingestVersion({ versionId: 'ver-1', extraction: extraction(), admin: {}, source })
    ).rejects.toBeInstanceOf(ReingestNotDraftError);

    // The destructive deletes never ran — the launched version's graph is intact.
    expect(tx.appQuestionnaireSection.deleteMany).not.toHaveBeenCalled();
    expect(tx.appQuestionnaireExtractionChange.deleteMany).not.toHaveBeenCalled();
    expect(tx.appQuestionTag.deleteMany).not.toHaveBeenCalled();
  });

  it('returns the structural counts and the resolved goal/audience', async () => {
    const result = await reingestVersion({
      versionId: 'ver-1',
      extraction: extraction(),
      admin: {},
      source,
    });

    // Assert the full ReingestVersionResult shape — including audience and
    // fieldProvenance — not just a subset, so a dropped/renamed field is caught.
    expect(result).toEqual({
      versionId: 'ver-1',
      sectionCount: 1,
      questionCount: 1,
      changeCount: 1,
      goal: 'Fresh goal',
      audience: null,
      fieldProvenance: { goal: 'inferred', audience: {} },
    });
  });
});

describe('reingestVersion — goal/audience merge', () => {
  it('keeps the version’s pre-existing goal when the new extraction infers none', async () => {
    current = { status: 'draft', goal: 'Original goal', audience: null };

    const result = await reingestVersion({
      versionId: 'ver-1',
      extraction: extraction({ inferredGoal: undefined, changes: [] }),
      admin: {},
      source,
    });

    expect(result.goal).toBe('Original goal');
    expect(result.fieldProvenance.goal).toBe('pre-existing');
  });

  it('lets an admin-supplied goal win over both inferred and pre-existing', async () => {
    current = { status: 'draft', goal: 'Original goal', audience: null };

    const result = await reingestVersion({
      versionId: 'ver-1',
      extraction: extraction(),
      admin: { goal: 'Admin goal' },
      source,
    });

    expect(result.goal).toBe('Admin goal');
    expect(result.fieldProvenance.goal).toBe('admin-supplied');
  });

  it('persists a resolved audience as JSON (non-null update path)', async () => {
    const result = await reingestVersion({
      versionId: 'ver-1',
      extraction: extraction({ inferredAudience: { role: 'manager' } }),
      admin: {},
      source,
    });

    // The merge resolved an audience → the version update writes it as JSON, and
    // the provenance map is non-empty (both non-null ternary arms exercised).
    expect(result.audience).toEqual({ role: 'manager' });
    expect(result.fieldProvenance.audience).toEqual({ role: 'inferred' });
    const updateArg = (tx.appQuestionnaireVersion.update as Mock).mock.calls[0][0];
    expect(updateArg.data.audience).toEqual({ role: 'manager' });
    expect(updateArg.data.audienceProvenance).toEqual({ role: 'inferred' });
  });
});
