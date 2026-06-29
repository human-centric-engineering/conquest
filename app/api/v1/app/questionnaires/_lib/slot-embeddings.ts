/**
 * Question-slot embeddings (F4.1 adaptive selection) — the pgvector seam.
 *
 * `AppQuestionSlot.embedding` is a `vector(1536)` column Prisma can't type
 * (modelled `Unsupported(...)`), so all reads/writes here go through raw SQL.
 * Two operations:
 *   - {@link embedVersionSlots} — generate + persist embeddings for a version's
 *     slots (admin backfill action), reusing the knowledge module's `embedBatch`.
 *   - {@link rankSlotsByVector} — cosine-similarity ranking of candidate slots
 *     against a query vector, backing the adaptive strategy's `rankByVector` dep.
 *
 * Route-local: the pure `selection/` module never imports this; it receives a
 * function with this shape through `StrategyDeps`.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import { QUESTIONNAIRE_EMBEDDING_DIMENSION } from '@/lib/app/questionnaire/constants';

/** The text embedded for a slot: prompt, plus guidelines when present. */
function slotEmbeddingText(slot: { prompt: string; guidelines: string | null }): string {
  return slot.guidelines ? `${slot.prompt}\n\n${slot.guidelines}` : slot.prompt;
}

/** pgvector text literal — `[0.1,0.2,…]` — for binding as a `::vector` param. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Minimal raw-SQL executor — satisfied by the module `prisma` and by the
 * transaction client `executeTransaction` hands its callback. Lets
 * {@link copySlotEmbeddings} run inside a caller's transaction without coupling
 * this module to the full Prisma client type.
 */
interface RawSqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Copy question-slot embeddings from one version to another, matching slots by
 * their per-version-unique `key`. The version-graph copy (fork / clone-for-client)
 * carries each slot's text verbatim, so its embedding is still valid — copying the
 * vectors avoids a needless (and costly) re-embed and keeps the new draft
 * adaptive-ready instead of silently degrading to `weighted`.
 *
 * The `embedding` column is Prisma-Unsupported, so this is a raw `UPDATE … FROM`
 * — Prisma's typed `create`/`createMany` (used to copy the rest of the graph)
 * cannot touch it, which is exactly why the copy dropped embeddings before. Runs
 * inside the caller's transaction so it commits atomically with the graph copy.
 */
export async function copySlotEmbeddings(
  exec: RawSqlExecutor,
  sourceVersionId: string,
  targetVersionId: string
): Promise<void> {
  await exec.$executeRawUnsafe(
    `UPDATE "app_question_slot" AS tgt
        SET "embedding" = src."embedding"
       FROM "app_question_slot" AS src
      WHERE tgt."versionId" = $1
        AND src."versionId" = $2
        AND tgt."key" = src."key"
        AND src."embedding" IS NOT NULL`,
    targetVersionId,
    sourceVersionId
  );
}

export interface EmbedVersionSlotsResult {
  /** Slots embedded this run. */
  embedded: number;
  /** Slots skipped (already embedded, when `onlyMissing`). */
  skipped: number;
  /** Total slots in the version. */
  total: number;
}

/**
 * Generate and persist embeddings for a version's question slots. With
 * `onlyMissing` (default), slots that already have an embedding are skipped — so
 * this is safe to re-run as a backfill. Cost is logged inside `embedBatch`.
 */
export async function embedVersionSlots(
  versionId: string,
  options: { onlyMissing?: boolean } = {}
): Promise<EmbedVersionSlotsResult> {
  const onlyMissing = options.onlyMissing ?? true;

  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    select: { id: true, prompt: true, guidelines: true },
  });
  if (slots.length === 0) return { embedded: 0, skipped: 0, total: 0 };

  let targets = slots;
  if (onlyMissing) {
    const missing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "app_question_slot" WHERE "versionId" = $1 AND "embedding" IS NULL`,
      versionId
    );
    const missingIds = new Set(missing.map((r) => r.id));
    targets = slots.filter((s) => missingIds.has(s.id));
  }

  if (targets.length === 0) {
    return { embedded: 0, skipped: slots.length, total: slots.length };
  }

  const { embeddings } = await embedBatch(targets.map(slotEmbeddingText), undefined, 'document');
  if (embeddings.length !== targets.length) {
    throw new Error(
      `Embedding count ${embeddings.length} does not match slot count ${targets.length}`
    );
  }

  // The `embedding` column is a fixed-width vector(QUESTIONNAIRE_EMBEDDING_DIMENSION).
  // If the active embedding provider emits a different width, the raw UPDATE would
  // fail mid-loop with an opaque pgvector error — fail fast at the boundary with an
  // actionable message instead, before touching the DB.
  const dim = embeddings[0]?.length ?? 0;
  if (dim !== QUESTIONNAIRE_EMBEDDING_DIMENSION) {
    throw new Error(
      `Active embedding model produces ${dim}-dim vectors, but app_question_slot.embedding is vector(${QUESTIONNAIRE_EMBEDDING_DIMENSION}). ` +
        `Adaptive selection requires a ${QUESTIONNAIRE_EMBEDDING_DIMENSION}-dim embedding model (matching the knowledge base).`
    );
  }

  // One UPDATE per slot — the column is Prisma-Unsupported, so no typed bulk path.
  for (let i = 0; i < targets.length; i++) {
    await prisma.$executeRawUnsafe(
      `UPDATE "app_question_slot" SET "embedding" = $1::vector WHERE "id" = $2`,
      toVectorLiteral(embeddings[i]),
      targets[i].id
    );
  }

  logger.info('Embedded questionnaire slots', {
    versionId,
    embedded: targets.length,
    skipped: slots.length - targets.length,
    total: slots.length,
  });

  return {
    embedded: targets.length,
    skipped: slots.length - targets.length,
    total: slots.length,
  };
}

export interface SlotEmbeddingCoverage {
  /** Total question slots in the version. */
  total: number;
  /** Slots that have an embedding. */
  embedded: number;
  /** Slots still missing an embedding (`total - embedded`). */
  missing: number;
}

/**
 * Report how many of a version's question slots are embedded. Backs the admin
 * "Generate embeddings" status in the Settings tab and the adaptive launch-gate
 * check. A version is launch-ready for adaptive when `total > 0 && missing === 0`.
 */
export async function slotEmbeddingCoverage(versionId: string): Promise<SlotEmbeddingCoverage> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; embedded: bigint }>>(
    `SELECT count(*)::bigint AS total, count("embedding")::bigint AS embedded
       FROM "app_question_slot" WHERE "versionId" = $1`,
    versionId
  );
  const total = Number(rows[0]?.total ?? 0);
  const embedded = Number(rows[0]?.embedded ?? 0);
  return { total, embedded, missing: total - embedded };
}

/**
 * Lazily ensure a version's slots are embedded for adaptive selection.
 *
 * Adaptive ranks unanswered questions by vector similarity, which needs every
 * slot to carry an `embedding`. Nothing in the authoring flow generates them, so
 * without this an `adaptive` version silently degrades to `weighted` forever (an
 * empty `rankSlotsByVector` result). The live turn path calls this the first time
 * an adaptive session runs.
 *
 * Cheap to call on every turn: a single `COUNT(… IS NULL)` short-circuits to a
 * no-op once the version is fully embedded, so only the first session of a fresh
 * (or newly edited) version pays the embed cost. Still throws if the embedder is
 * unconfigured — callers on the respondent hot path MUST wrap in try/catch so a
 * failed embed degrades to `weighted` rather than breaking the turn.
 */
export async function ensureVersionSlotsEmbedded(
  versionId: string
): Promise<EmbedVersionSlotsResult> {
  const rows = await prisma.$queryRawUnsafe<Array<{ missing: bigint }>>(
    `SELECT count(*)::bigint AS missing FROM "app_question_slot" WHERE "versionId" = $1 AND "embedding" IS NULL`,
    versionId
  );
  if (Number(rows[0]?.missing ?? 0) === 0) {
    return { embedded: 0, skipped: 0, total: 0 };
  }
  return embedVersionSlots(versionId, { onlyMissing: true });
}

/**
 * Rank `candidateIds` by cosine similarity to `embedding`, returning at most `k`
 * slot ids best-first. Only slots that actually have an embedding participate —
 * an un-embedded version yields `[]`, which the adaptive strategy reads as its
 * cue to fall back to `weighted`.
 */
export async function rankSlotsByVector(
  embedding: number[],
  candidateIds: string[],
  k: number
): Promise<string[]> {
  if (candidateIds.length === 0 || k <= 0) return [];
  // Expand the candidate ids into individual placeholders ($3, $4, …) rather
  // than binding a JS array to `ANY($n)` — the same approach the knowledge
  // hybrid-search query uses (`search.ts`), which avoids relying on Prisma's
  // array-parameter binding through `$queryRawUnsafe`.
  const idPlaceholders = candidateIds.map((_, i) => `$${i + 3}`).join(', ');
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "app_question_slot"
     WHERE "id" IN (${idPlaceholders}) AND "embedding" IS NOT NULL
     ORDER BY ("embedding" <=> $1::vector) ASC
     LIMIT $2`,
    toVectorLiteral(embedding),
    k,
    ...candidateIds
  );
  return rows.map((r) => r.id);
}

/**
 * Lexical (BM25-style) ranking of `candidateIds` against `queryText` via Postgres full-text search
 * (`ts_rank_cd` over `websearch_to_tsquery`), returning at most `k` ids best-first. The lexical
 * complement to {@link rankSlotsByVector}: the extraction pre-filter UNIONs the two so an exact term
 * the respondent used ("pipeline") surfaces its question even when a multi-topic message's dense
 * vector dilutes it below the dense top-K. No `tsvector` column — `to_tsvector` is computed inline
 * (the candidate set is one version's slots, so the seq-scan is trivial). Empty/stopword-only query
 * → `[]`.
 */
export async function rankSlotsByText(
  queryText: string,
  candidateIds: string[],
  k: number
): Promise<string[]> {
  const q = queryText.trim();
  if (!q || candidateIds.length === 0 || k <= 0) return [];
  const idPlaceholders = candidateIds.map((_, i) => `$${i + 3}`).join(', ');
  const tsv = `to_tsvector('english', coalesce("prompt", '') || ' ' || coalesce("guidelines", ''))`;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "app_question_slot"
     WHERE "id" IN (${idPlaceholders}) AND ${tsv} @@ plainto_tsquery('english', $1)
     ORDER BY ts_rank_cd(${tsv}, plainto_tsquery('english', $1), 32) DESC
     LIMIT $2`,
    q,
    k,
    ...candidateIds
  );
  return rows.map((r) => r.id);
}

/**
 * Among `candidateIds`, find the question slots that are NEAR-DUPLICATES of any `keptId` — cosine
 * distance ≤ `maxDistance` (i.e. similarity ≥ `1 - maxDistance`). Backs the extraction pre-filter's
 * twin-inclusion rail: when a question is kept, its semantically-identical siblings (the same
 * question reworded in another section) are pulled in too, so a clear answer lands on EVERY copy,
 * not just the one the ranking happened to surface. Only embedded slots participate; `[]` on empty
 * input.
 */
export async function findDuplicateSlotIds(
  keptIds: string[],
  candidateIds: string[],
  maxDistance: number
): Promise<string[]> {
  if (keptIds.length === 0 || candidateIds.length === 0) return [];
  const keptPh = keptIds.map((_, i) => `$${i + 2}`).join(', ');
  const candPh = candidateIds.map((_, i) => `$${i + 2 + keptIds.length}`).join(', ');
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT b."id" FROM "app_question_slot" a
     JOIN "app_question_slot" b ON a."id" <> b."id"
     WHERE a."id" IN (${keptPh}) AND b."id" IN (${candPh})
       AND a."embedding" IS NOT NULL AND b."embedding" IS NOT NULL
       AND (a."embedding" <=> b."embedding") <= $1`,
    maxDistance,
    ...keptIds,
    ...candidateIds
  );
  return rows.map((r) => r.id);
}
