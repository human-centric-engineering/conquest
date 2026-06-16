/**
 * Unit test: data-slot embedding seam (adaptive data-slot selection).
 *
 * The data-slot analogue of `slot-embeddings.test.ts`. The pgvector reads/writes go through raw
 * SQL, so this mocks `prisma` and the knowledge `embedBatch` and asserts: only-missing filtering,
 * the force path, per-slot UPDATE writes, the empty-version short-circuit, the dimension guard,
 * coverage, the lazy ensure, and cosine-rank delegation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({ embedBatch: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appDataSlot: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  dataSlotEmbeddingCoverage,
  embedVersionDataSlots,
  ensureVersionDataSlotsEmbedded,
  rankDataSlotsByVector,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import { QUESTIONNAIRE_EMBEDDING_DIMENSION } from '@/lib/app/questionnaire/constants';

type Mock = ReturnType<typeof vi.fn>;

const slots = [
  { id: 'a', name: 'Name A', description: 'Desc A' },
  { id: 'b', name: 'Name B', description: 'Desc B' },
  { id: 'c', name: 'Name C', description: 'Desc C' },
];

/** A correctly-sized embedding vector filled with `v` (the column is vector(1536)). */
function vec(v: number): number[] {
  return Array.from({ length: QUESTIONNAIRE_EMBEDDING_DIMENSION }, () => v);
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appDataSlot.findMany.mockResolvedValue(slots);
  prismaMock.$executeRawUnsafe.mockResolvedValue(1);
});

describe('embedVersionDataSlots', () => {
  it('embeds only the slots missing an embedding (default), folding name + description', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }, { id: 'c' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [vec(0.1), vec(0.3)] });

    const result = await embedVersionDataSlots('v1');

    expect(result).toEqual({ embedded: 2, skipped: 1, total: 3 });
    expect(embedBatch).toHaveBeenCalledWith(
      ['Name B\n\nDesc B', 'Name C\n\nDesc C'],
      undefined,
      'document'
    );
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "app_data_slot"'),
      `[${vec(0.1).join(',')}]`,
      'b'
    );
  });

  it('throws a clear error when the embedding width does not match the column', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({
      embeddings: [Array.from({ length: 768 }, () => 0.1)],
    });
    await expect(embedVersionDataSlots('v1')).rejects.toThrow(/768-dim vectors.*vector\(1536\)/);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('re-embeds every slot when force is set (no missing-query)', async () => {
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [vec(1), vec(2), vec(3)] });
    const result = await embedVersionDataSlots('v1', { onlyMissing: false });
    expect(result).toEqual({ embedded: 3, skipped: 0, total: 3 });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it('short-circuits a version with no data slots (no embedding call)', async () => {
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);
    const result = await embedVersionDataSlots('v1');
    expect(result).toEqual({ embedded: 0, skipped: 0, total: 0 });
    expect(embedBatch).not.toHaveBeenCalled();
  });
});

describe('dataSlotEmbeddingCoverage', () => {
  it('reports total / embedded / missing from the COUNT query', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ total: 5n, embedded: 2n }]);
    expect(await dataSlotEmbeddingCoverage('v1')).toEqual({ total: 5, embedded: 2, missing: 3 });
  });

  it('returns all-zero for a version with no data slots', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ total: 0n, embedded: 0n }]);
    expect(await dataSlotEmbeddingCoverage('v1')).toEqual({ total: 0, embedded: 0, missing: 0 });
  });
});

describe('ensureVersionDataSlotsEmbedded', () => {
  it('no-ops via the cheap COUNT when fully embedded', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ missing: 0n }]);
    const result = await ensureVersionDataSlotsEmbedded('v1');
    expect(result).toEqual({ embedded: 0, skipped: 0, total: 0 });
    expect(prismaMock.appDataSlot.findMany).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('embeds the missing slots when some are unembedded', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ missing: 2n }])
      .mockResolvedValueOnce([{ id: 'b' }, { id: 'c' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [vec(0.1), vec(0.3)] });

    const result = await ensureVersionDataSlotsEmbedded('v1');

    expect(result).toEqual({ embedded: 2, skipped: 1, total: 3 });
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });
});

describe('rankDataSlotsByVector', () => {
  it('returns [] for an empty candidate list or non-positive k without querying', async () => {
    expect(await rankDataSlotsByVector([0.1], [], 5)).toEqual([]);
    expect(await rankDataSlotsByVector([0.1], ['a'], 0)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns the ranked ids the cosine query yields, in order', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'c' }, { id: 'a' }]);
    const ranked = await rankDataSlotsByVector([0.1, 0.2], ['a', 'b', 'c'], 2);
    expect(ranked).toEqual(['c', 'a']);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('<=>'),
      '[0.1,0.2]',
      2,
      'a',
      'b',
      'c'
    );
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('"app_data_slot"');
  });
});
