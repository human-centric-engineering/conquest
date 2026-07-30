/**
 * Stored-vector dimension guard, independent of which table stores the vectors.
 *
 * `pgvector` fixes dimension at the column level, so changing the active
 * embedding model without re-embedding breaks *every* query against a vector
 * table with a cast error — after paying for the embedding round trip. The
 * cause (a settings change, possibly weeks earlier) is far from the symptom (a
 * cast error inside a vector query), which is what makes it expensive to
 * diagnose rather than merely broken.
 *
 * Sunrise's own knowledge corpus is guarded by `search.ts`. This module exists
 * because a fork that adds its own `vector(...)` table inherits the same failure
 * mode with none of the protection — and adding one is the *documented* path,
 * since the platform knowledge base is a global asset and per-user scoping there
 * is an anti-pattern (see `.context/orchestration/knowledge.md`). Before this,
 * the only way to get the guard was to copy it, and a copy does not learn what
 * the original learns.
 *
 * The subject is expressed as two closures rather than a Prisma delegate. That
 * keeps the guard free of delegate typing gymnastics and works for a fork whose
 * vector table is not a Prisma model at all.
 */

import { getActiveEmbeddingModelSummary } from '@/lib/orchestration/knowledge/embedder';

/** One `(dimension, count)` bucket of stored vectors. */
export interface StoredVectorDimensionGroup {
  /** Recorded dimension, or null on rows that predate dimension tracking. */
  dimension: number | null;
  /** How many rows sit at this dimension. */
  count: number;
}

/** What the guard needs to know about one store of vectors. */
export interface StoredVectorSubject {
  /**
   * Singular noun for a row, used in the error summary — `'chunk'` yields
   * "17 chunk(s) embedded by …". Name the thing the operator recognises.
   */
  label: string;
  /**
   * What the operator should actually run, appended to the error verbatim. A
   * mismatch is not self-explanatory: without a concrete command this reads as
   * a bug report rather than an instruction.
   */
  remediation: string;
  /**
   * Row counts bucketed by recorded dimension. Rows with no recorded dimension
   * should be excluded — they predate dimension tracking and were 1536 by
   * construction, so treating them as a mismatch would be a false alarm.
   */
  groupByDimension: () => Promise<StoredVectorDimensionGroup[]>;
  /**
   * One example model name for a mismatched dimension, so the operator sees
   * what produced those rows without spelunking. Return null when unknown.
   */
  exemplarModel: (dimension: number | null) => Promise<string | null>;
}

/**
 * Throw when stored vectors disagree with the active embedding model's
 * dimension. Call it BEFORE embedding the query — the point is to fail without
 * paying for the round trip.
 *
 * Silent no-op when no active model is set (the legacy fallback path: stored
 * vectors are 1536 by construction and the embedder produces 1536), when the
 * store is empty, and when every bucket already matches.
 *
 * Buckets rather than sampling a single row on purpose: a partially re-embedded
 * store (some rows at the old dimension, some at the new) is the state an
 * aborted reset leaves behind, and a `findFirst` that happened to land on a
 * matching row would report all-clear on a corpus that is half broken.
 */
export async function assertStoredVectorDimensions(subject: StoredVectorSubject): Promise<void> {
  const active = await getActiveEmbeddingModelSummary();
  if (!active) return;

  const groups = await subject.groupByDimension();
  if (groups.length === 0) return;

  const mismatched = groups.filter((g) => g.dimension !== active.dimensions);
  if (mismatched.length === 0) return;

  const exemplars = await Promise.all(
    mismatched.map(async (g) => ({
      dimension: g.dimension,
      count: g.count,
      model: (await subject.exemplarModel(g.dimension)) ?? 'unknown',
    }))
  );

  const summary = exemplars
    .map((e) => `${e.count} ${subject.label}(s) embedded by "${e.model}" at ${e.dimension} dims`)
    .join('; ');

  throw new Error(
    `Embedding model mismatch: the active model "${active.modelId}" produces ` +
      `${active.dimensions}-dim vectors, but the corpus contains: ${summary}. ` +
      subject.remediation
  );
}
