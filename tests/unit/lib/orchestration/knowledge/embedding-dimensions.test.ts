/**
 * Table-agnostic stored-vector dimension guard (#491).
 *
 * The knowledge-corpus binding is covered indirectly through `searchKnowledge`
 * in `search.test.ts`. These tests exercise the guard directly — the thing a
 * fork calls with its own vector table — and pin the parts a fork depends on:
 * which states are silent, that the error names every mismatched bucket rather
 * than the first, and that `label` / `remediation` actually reach the message.
 *
 * @see lib/orchestration/knowledge/embedding-dimensions.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  getActiveEmbeddingModelSummary: vi.fn(),
}));

import { getActiveEmbeddingModelSummary } from '@/lib/orchestration/knowledge/embedder';
import {
  assertStoredVectorDimensions,
  type StoredVectorDimensionGroup,
} from '@/lib/orchestration/knowledge/embedding-dimensions';

const activeModel = vi.mocked(getActiveEmbeddingModelSummary);

/** A fork's subject: its own table, its own noun, its own remediation. */
function subject(
  groups: StoredVectorDimensionGroup[],
  model: string | null = 'text-embedding-3-small'
) {
  return {
    label: 'note',
    remediation: 'Run `npm run obsiddy:reindex` to re-embed your brain.',
    groupByDimension: vi.fn().mockResolvedValue(groups),
    exemplarModel: vi.fn().mockResolvedValue(model),
  };
}

beforeEach(() => {
  activeModel.mockReset();
  activeModel.mockResolvedValue({ modelId: 'voyage-3', dimensions: 1024 });
});

describe('assertStoredVectorDimensions — silent cases', () => {
  it('does nothing when no active model is set', async () => {
    // Legacy fallback path: stored vectors are 1536 by construction and the
    // embedder produces 1536, so there is nothing to compare.
    activeModel.mockResolvedValue(null);
    const s = subject([{ dimension: 1536, count: 99 }]);

    await expect(assertStoredVectorDimensions(s)).resolves.toBeUndefined();
    // Must not even ask the store — the guard is inapplicable, not passing.
    expect(s.groupByDimension).not.toHaveBeenCalled();
  });

  it('does nothing when the store is empty', async () => {
    const s = subject([]);
    await expect(assertStoredVectorDimensions(s)).resolves.toBeUndefined();
    expect(s.exemplarModel).not.toHaveBeenCalled();
  });

  it('does nothing when every bucket already matches the active dimension', async () => {
    const s = subject([{ dimension: 1024, count: 40 }]);
    await expect(assertStoredVectorDimensions(s)).resolves.toBeUndefined();
    expect(s.exemplarModel).not.toHaveBeenCalled();
  });
});

describe('assertStoredVectorDimensions — mismatch', () => {
  it("uses the subject's own label and remediation, not the knowledge corpus's", async () => {
    // The whole point of the export: a fork's error must talk about its own
    // thing and tell the operator the command that fixes IT.
    const s = subject([{ dimension: 1536, count: 17 }]);

    await expect(assertStoredVectorDimensions(s)).rejects.toThrow(
      /17 note\(s\) embedded by "text-embedding-3-small" at 1536 dims/
    );
    await expect(assertStoredVectorDimensions(s)).rejects.toThrow(/obsiddy:reindex/);
  });

  it('names the active model and its dimension so the cause is in the message', async () => {
    // The cause is a settings change, possibly weeks before the symptom. If the
    // error does not name the active model the operator has to go looking.
    const s = subject([{ dimension: 1536, count: 3 }]);

    await expect(assertStoredVectorDimensions(s)).rejects.toThrow(
      /active model "voyage-3" produces 1024-dim vectors/
    );
  });

  it('names every mismatched bucket, not just the first', async () => {
    // An aborted reset leaves a partially re-embedded store. Reporting one
    // bucket would understate the damage and make the fix look complete when
    // it is not.
    const s = {
      label: 'note',
      remediation: 'fix it',
      groupByDimension: vi.fn().mockResolvedValue([
        { dimension: 1536, count: 17 },
        { dimension: 768, count: 5 },
        { dimension: 1024, count: 8 },
      ] as StoredVectorDimensionGroup[]),
      exemplarModel: vi
        .fn()
        .mockResolvedValueOnce('text-embedding-3-small')
        .mockResolvedValueOnce('nomic-embed-text'),
    };

    const err = await assertStoredVectorDimensions(s).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('17 note(s)');
    expect((err as Error).message).toContain('5 note(s)');
    // The matching bucket (1024) is not a problem and must not be listed.
    expect((err as Error).message).not.toContain('8 note(s)');
  });

  it('only looks up exemplars for mismatched buckets', async () => {
    // Each exemplar is a query. Fetching one for a bucket that already matches
    // is wasted work on the failure path of a guard that runs before every
    // search.
    const s = {
      label: 'note',
      remediation: 'fix it',
      groupByDimension: vi.fn().mockResolvedValue([
        { dimension: 1024, count: 8 },
        { dimension: 1536, count: 2 },
      ] as StoredVectorDimensionGroup[]),
      exemplarModel: vi.fn().mockResolvedValue('old-model'),
    };

    await assertStoredVectorDimensions(s).catch(() => undefined);

    expect(s.exemplarModel).toHaveBeenCalledTimes(1);
    expect(s.exemplarModel).toHaveBeenCalledWith(1536);
  });

  it('renders an unknown exemplar rather than dropping the bucket', async () => {
    // A fork may not record the model name. The bucket still has to appear —
    // its count is the number of rows that need re-embedding.
    const s = subject([{ dimension: 1536, count: 12 }], null);

    await expect(assertStoredVectorDimensions(s)).rejects.toThrow(
      /12 note\(s\) embedded by "unknown" at 1536 dims/
    );
  });

  it('treats a null dimension as a mismatch when an active model is set', async () => {
    // A row with no recorded dimension cannot be proven to match. Subjects are
    // told to exclude those in `groupByDimension`; if one arrives anyway the
    // guard must not silently pass it.
    const s = subject([{ dimension: null, count: 4 }]);

    await expect(assertStoredVectorDimensions(s)).rejects.toThrow(/4 note\(s\)/);
  });
});
