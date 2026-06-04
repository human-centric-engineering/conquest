/**
 * Unit test: question-slot embedding seam (F4.1 / PR3).
 *
 * The pgvector reads/writes go through raw SQL, so this mocks `prisma` and the
 * knowledge `embedBatch` and asserts: only-missing filtering, the force path,
 * per-slot UPDATE writes, the empty-version short-circuit, the count/embedding
 * mismatch guard, and cosine-rank delegation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedBatch: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionSlot: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  embedVersionSlots,
  rankSlotsByVector,
} from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import { QUESTIONNAIRE_EMBEDDING_DIMENSION } from '@/lib/app/questionnaire/constants';

type Mock = ReturnType<typeof vi.fn>;

const slots = [
  { id: 'a', prompt: 'P-a', guidelines: null },
  { id: 'b', prompt: 'P-b', guidelines: 'G-b' },
  { id: 'c', prompt: 'P-c', guidelines: null },
];

/** A correctly-sized embedding vector filled with `v` (the column is vector(1536)). */
function vec(v: number): number[] {
  return Array.from({ length: QUESTIONNAIRE_EMBEDDING_DIMENSION }, () => v);
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionSlot.findMany.mockResolvedValue(slots);
  prismaMock.$executeRawUnsafe.mockResolvedValue(1);
});

describe('embedVersionSlots', () => {
  it('embeds only the slots missing an embedding (default)', async () => {
    // b + c are missing; a already has one.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }, { id: 'c' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [vec(0.1), vec(0.3)] });

    const result = await embedVersionSlots('v1');

    expect(result).toEqual({ embedded: 2, skipped: 1, total: 3 });
    // b's text folds in guidelines; c's doesn't.
    expect(embedBatch).toHaveBeenCalledWith(['P-b\n\nG-b', 'P-c'], undefined, 'document');
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    // Each UPDATE binds a pgvector literal + the slot id.
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "app_question_slot"'),
      `[${vec(0.1).join(',')}]`,
      'b'
    );
  });

  it('throws a clear error when the embedding width does not match the column', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }, { id: 'c' }]);
    // Active model emits 768-dim vectors, but the column is vector(1536).
    (embedBatch as unknown as Mock).mockResolvedValue({
      embeddings: [Array.from({ length: 768 }, () => 0.1), Array.from({ length: 768 }, () => 0.2)],
    });
    await expect(embedVersionSlots('v1')).rejects.toThrow(/768-dim vectors.*vector\(1536\)/);
    // Fails fast — no UPDATE issued.
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('re-embeds every slot when force is set (no missing-query)', async () => {
    (embedBatch as unknown as Mock).mockResolvedValue({
      embeddings: [vec(1), vec(2), vec(3)],
    });
    const result = await embedVersionSlots('v1', { onlyMissing: false });
    expect(result).toEqual({ embedded: 3, skipped: 0, total: 3 });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it('short-circuits a version with no slots (no embedding call)', async () => {
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([]);
    const result = await embedVersionSlots('v1');
    expect(result).toEqual({ embedded: 0, skipped: 0, total: 0 });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('skips when nothing is missing', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    const result = await embedVersionSlots('v1');
    expect(result).toEqual({ embedded: 0, skipped: 3, total: 3 });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('throws if the embedding count does not match the slot count', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }, { id: 'c' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [[0.1]] });
    await expect(embedVersionSlots('v1')).rejects.toThrow(/does not match/);
  });
});

describe('rankSlotsByVector', () => {
  it('returns [] for an empty candidate list without querying', async () => {
    expect(await rankSlotsByVector([0.1], [], 5)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns [] for a non-positive k', async () => {
    expect(await rankSlotsByVector([0.1], ['a'], 0)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns the ranked ids the cosine query yields, in order', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'c' }, { id: 'a' }]);
    const ranked = await rankSlotsByVector([0.1, 0.2], ['a', 'b', 'c'], 2);
    expect(ranked).toEqual(['c', 'a']);
    // vector literal ($1), limit ($2), then the candidate ids expanded ($3..$5).
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('<=>'),
      '[0.1,0.2]',
      2,
      'a',
      'b',
      'c'
    );
    // ids are expanded into IN-placeholders, not bound as an array.
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('IN ($3, $4, $5)');
  });
});
