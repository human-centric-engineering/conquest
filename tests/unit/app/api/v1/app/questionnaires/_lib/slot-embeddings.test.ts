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
  copySlotEmbeddings,
  embedVersionSlots,
  ensureVersionSlotsEmbedded,
  findDuplicateSlotIds,
  rankSlotsByText,
  rankSlotsByVector,
  slotEmbeddingCoverage,
  typedQuestionCohesion,
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

describe('copySlotEmbeddings', () => {
  it('copies vectors source→target in one UPDATE … FROM keyed on key', async () => {
    await copySlotEmbeddings(prismaMock, 'src-ver', 'tgt-ver');

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = (prismaMock.$executeRawUnsafe as Mock).mock.calls[0];
    // A single set-based copy, not a per-row loop.
    expect(sql).toContain('UPDATE "app_question_slot"');
    expect(sql).toContain('FROM "app_question_slot"');
    expect(sql).toContain('tgt."key" = src."key"');
    // Only source rows that actually have a vector are carried.
    expect(sql).toContain('src."embedding" IS NOT NULL');
    // $1 = target version, $2 = source version (the UPDATE writes the target).
    expect(params).toEqual(['tgt-ver', 'src-ver']);
  });

  it('runs against the supplied executor (a transaction client), not module prisma', async () => {
    // The fork/clone copy passes its tx client so the embedding copy commits
    // atomically with the graph copy — verify the helper uses what it's given.
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(3) };
    await copySlotEmbeddings(tx, 'src-ver', 'tgt-ver');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('slotEmbeddingCoverage', () => {
  it('reports total / embedded / missing from the COUNT query', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ total: 5n, embedded: 2n }]);
    expect(await slotEmbeddingCoverage('v1')).toEqual({ total: 5, embedded: 2, missing: 3 });
  });

  it('treats a fully-embedded version as zero missing', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ total: 7n, embedded: 7n }]);
    expect(await slotEmbeddingCoverage('v1')).toEqual({ total: 7, embedded: 7, missing: 0 });
  });

  it('returns all-zero for a version with no slots', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ total: 0n, embedded: 0n }]);
    expect(await slotEmbeddingCoverage('v1')).toEqual({ total: 0, embedded: 0, missing: 0 });
  });
});

describe('ensureVersionSlotsEmbedded', () => {
  it('no-ops via the cheap COUNT when the version is fully embedded', async () => {
    // COUNT(… IS NULL) → 0 missing: the lazy path must short-circuit here.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ missing: 0n }]);

    const result = await ensureVersionSlotsEmbedded('v1');

    expect(result).toEqual({ embedded: 0, skipped: 0, total: 0 });
    // No slot load, no embedding work — only the one COUNT query ran.
    expect(prismaMock.appQuestionSlot.findMany).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('embeds only the missing slots when some are unembedded', async () => {
    // 1st $queryRawUnsafe = the COUNT (2 missing); 2nd = the missing-id list
    // inside the delegated embedVersionSlots(onlyMissing) call.
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ missing: 2n }])
      .mockResolvedValueOnce([{ id: 'b' }, { id: 'c' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [vec(0.1), vec(0.3)] });

    const result = await ensureVersionSlotsEmbedded('v1');

    expect(result).toEqual({ embedded: 2, skipped: 1, total: 3 });
    expect(embedBatch).toHaveBeenCalledWith(['P-b\n\nG-b', 'P-c'], undefined, 'document');
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2);
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

describe('slotEmbeddingCoverage — null-row guard', () => {
  it('returns all-zero when the COUNT query returns no rows (empty version)', async () => {
    // Exercises the `rows[0]?.total ?? 0` and `rows[0]?.embedded ?? 0` null-coalescing branches.
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    expect(await slotEmbeddingCoverage('v-empty')).toEqual({ total: 0, embedded: 0, missing: 0 });
  });
});

describe('ensureVersionSlotsEmbedded — null-row guard', () => {
  it('treats a missing-count query with no rows as zero missing (short-circuits)', async () => {
    // Exercises the `rows[0]?.missing ?? 0` null-coalescing branch.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await ensureVersionSlotsEmbedded('v-empty');
    expect(result).toEqual({ embedded: 0, skipped: 0, total: 0 });
    expect(prismaMock.appQuestionSlot.findMany).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });
});

describe('embedVersionSlots — pre-write guards', () => {
  it('throws when the embedder returns fewer vectors than slots, before any UPDATE', async () => {
    // Count mismatch is checked FIRST, so this never reaches the dimension guard below.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [] });
    await expect(embedVersionSlots('v1')).rejects.toThrow(/does not match slot count/);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('throws a dimension error when the model emits the wrong vector width', async () => {
    // The column is vector(QUESTIONNAIRE_EMBEDDING_DIMENSION), so a provider swap that changes the
    // width must fail fast with an actionable message rather than an opaque pgvector error mid-loop.
    // Counts MUST match here, otherwise the count guard throws first and this branch stays dark.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] });
    await expect(embedVersionSlots('v1')).rejects.toThrow(
      new RegExp(`3-dim vectors.*vector\\(${QUESTIONNAIRE_EMBEDDING_DIMENSION}\\)`)
    );
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('treats an empty first vector as 0-dim and refuses to write', async () => {
    // The `embeddings[0]?.length ?? 0` fallback: a degenerate empty vector must be rejected by the
    // dimension guard, not silently written as a zero-width value.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }]);
    (embedBatch as unknown as Mock).mockResolvedValue({ embeddings: [[]] });
    await expect(embedVersionSlots('v1')).rejects.toThrow(/0-dim vectors/);
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('rankSlotsByText', () => {
  it('returns [] for an empty query string without querying', async () => {
    // Exercises the `!q` early-return branch (line 210).
    expect(await rankSlotsByText('', ['a', 'b'], 5)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns [] for a whitespace-only query without querying', async () => {
    // trim() collapses to '' — same `!q` branch.
    expect(await rankSlotsByText('   ', ['a', 'b'], 5)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns [] for an empty candidate list without querying', async () => {
    expect(await rankSlotsByText('pipeline', [], 5)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns [] for a non-positive k without querying', async () => {
    expect(await rankSlotsByText('pipeline', ['a'], 0)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns BM25-ranked ids the full-text query yields, in order', async () => {
    // Arrange: DB returns two matches best-first.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'b' }, { id: 'a' }]);

    // Act
    const ranked = await rankSlotsByText('pipeline', ['a', 'b', 'c'], 2);

    // Assert: the ranked order comes from the DB, not just the input order.
    expect(ranked).toEqual(['b', 'a']);
    // The query uses plainto_tsquery and ts_rank_cd — verify the SQL shape.
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('plainto_tsquery'),
      'pipeline',
      2,
      'a',
      'b',
      'c'
    );
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('ts_rank_cd');
    // Candidate ids expand into IN-placeholders, not bound as an array.
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('IN ($3, $4, $5)');
  });

  it('trims leading/trailing whitespace from the query before passing to SQL', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'a' }]);
    await rankSlotsByText('  pipeline  ', ['a'], 3);
    // $1 bound to the trimmed value, not the padded one.
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 'pipeline', 3, 'a');
  });
});

describe('findDuplicateSlotIds', () => {
  it('returns [] for an empty keptIds list without querying', async () => {
    // Exercises the `keptIds.length === 0` guard (line 238).
    expect(await findDuplicateSlotIds([], ['a', 'b'], 0.1)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns [] for an empty candidateIds list without querying', async () => {
    // Exercises the `candidateIds.length === 0` guard (line 238).
    expect(await findDuplicateSlotIds(['kept-1'], [], 0.1)).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns the near-duplicate candidate ids the self-join query yields', async () => {
    // Arrange: two of the candidates are near-duplicates of the kept slot.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 'dup-1' }, { id: 'dup-2' }]);

    // Act
    const dupes = await findDuplicateSlotIds(['kept-1'], ['dup-1', 'dup-2', 'other'], 0.15);

    // Assert: the function maps row ids and returns them.
    expect(dupes).toEqual(['dup-1', 'dup-2']);
    // Verify the SQL self-join shape: maxDistance ($1), kept ids, candidate ids.
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('app_question_slot" a'),
      0.15,
      'kept-1',
      'dup-1',
      'dup-2',
      'other'
    );
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('<=>');
    expect((prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0]).toContain('DISTINCT');
  });

  it('builds separate placeholder ranges for keptIds and candidateIds', async () => {
    // kept: $2; candidates: $3, $4 — offsets must not overlap.
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    await findDuplicateSlotIds(['k1'], ['c1', 'c2'], 0.1);
    const sql = (prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0] as string;
    // kept IN ($2), candidates IN ($3, $4)
    expect(sql).toContain('IN ($2)');
    expect(sql).toContain('IN ($3, $4)');
  });
});

describe('typedQuestionCohesion', () => {
  it('returns the mean nearest-sibling similarity the query yields', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ cohesion: 0.72 }]);
    expect(await typedQuestionCohesion('v1')).toBe(0.72);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 'v1');
  });

  it('measures NEAREST-sibling similarity, excluding free text and self-pairs', async () => {
    // The three load-bearing clauses. Free text is excluded because a slot records one position,
    // so similar free-text questions still need separate slots — counting them would read that
    // similarity as licence to consolidate. Self-pairs would score a flat 1.0 for every question.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ cohesion: 0.6 }]);
    await typedQuestionCohesion('v1');
    const sql = (prismaMock.$queryRawUnsafe as Mock).mock.calls[0][0] as string;
    expect(sql).toContain('"type" <> \'free_text\'');
    expect(sql).toContain('a."id" <> b."id"');
    expect(sql).toMatch(/max\(1 - \(a\."embedding" <=> b\."embedding"\)\)/);
    expect(sql).toContain('"embedding" IS NOT NULL');
  });

  it('returns null when there is nothing to measure (avg over no rows)', async () => {
    // Fewer than two embedded typed questions — the join yields nothing and avg() is SQL NULL.
    // Null must NOT collapse to 0, which would read as "maximally distinct" and shift the band.
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ cohesion: null }]);
    expect(await typedQuestionCohesion('v1')).toBeNull();
  });

  it('returns null for an empty result set', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    expect(await typedQuestionCohesion('v1')).toBeNull();
  });

  it('rejects a non-finite value rather than passing NaN into the band maths', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ cohesion: Number.NaN }]);
    expect(await typedQuestionCohesion('v1')).toBeNull();
  });
});
