/**
 * Data-slot embeddings (adaptive data-slot selection) — the pgvector seam.
 *
 * The data-slot analogue of `slot-embeddings.ts` (question slots). `AppDataSlot.embedding` is a
 * `vector(1536)` column Prisma can't type (modelled `Unsupported(...)`), so all reads/writes here
 * go through raw SQL. Operations:
 *   - {@link embedVersionDataSlots} — generate + persist embeddings for a version's data slots
 *     (admin action / lazy backfill), reusing the knowledge module's `embedBatch`.
 *   - {@link dataSlotEmbeddingCoverage} — `{ total, embedded, missing }` for the Settings step +
 *     the adaptive launch-gate check.
 *   - {@link ensureVersionDataSlotsEmbedded} — cheap lazy ensure on the live data-slot turn path.
 *   - {@link rankDataSlotsByVector} — cosine-similarity ranking of candidate data slots against a
 *     query vector, backing the adaptive selection pre-filter at 50+-slot scale.
 *
 * Route-local: the pure `selection/` and `orchestrator/` modules never import this; the runtime
 * receives functions with these shapes through injected deps.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import { QUESTIONNAIRE_EMBEDDING_DIMENSION } from '@/lib/app/questionnaire/constants';

/** The text embedded for a data slot: its short name plus the description (intent + what counts). */
function dataSlotEmbeddingText(slot: { name: string; description: string }): string {
  return slot.description ? `${slot.name}\n\n${slot.description}` : slot.name;
}

/** pgvector text literal — `[0.1,0.2,…]` — for binding as a `::vector` param. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export interface EmbedVersionDataSlotsResult {
  /** Data slots embedded this run. */
  embedded: number;
  /** Data slots skipped (already embedded, when `onlyMissing`). */
  skipped: number;
  /** Total data slots in the version. */
  total: number;
}

/**
 * Generate and persist embeddings for a version's data slots. With `onlyMissing` (default), slots
 * that already have an embedding are skipped — so this is safe to re-run as a backfill. Cost is
 * logged inside `embedBatch`.
 */
export async function embedVersionDataSlots(
  versionId: string,
  options: { onlyMissing?: boolean } = {}
): Promise<EmbedVersionDataSlotsResult> {
  const onlyMissing = options.onlyMissing ?? true;

  const slots = await prisma.appDataSlot.findMany({
    where: { versionId },
    select: { id: true, name: true, description: true },
  });
  if (slots.length === 0) return { embedded: 0, skipped: 0, total: 0 };

  let targets = slots;
  if (onlyMissing) {
    const missing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "app_data_slot" WHERE "versionId" = $1 AND "embedding" IS NULL`,
      versionId
    );
    const missingIds = new Set(missing.map((r) => r.id));
    targets = slots.filter((s) => missingIds.has(s.id));
  }

  if (targets.length === 0) {
    return { embedded: 0, skipped: slots.length, total: slots.length };
  }

  const { embeddings } = await embedBatch(
    targets.map(dataSlotEmbeddingText),
    undefined,
    'document'
  );
  if (embeddings.length !== targets.length) {
    throw new Error(
      `Embedding count ${embeddings.length} does not match data-slot count ${targets.length}`
    );
  }

  // The `embedding` column is a fixed-width vector(QUESTIONNAIRE_EMBEDDING_DIMENSION). Fail fast at
  // the boundary with an actionable message if the active provider emits a different width, rather
  // than a mid-loop opaque pgvector error.
  const dim = embeddings[0]?.length ?? 0;
  if (dim !== QUESTIONNAIRE_EMBEDDING_DIMENSION) {
    throw new Error(
      `Active embedding model produces ${dim}-dim vectors, but app_data_slot.embedding is vector(${QUESTIONNAIRE_EMBEDDING_DIMENSION}). ` +
        `Adaptive data-slot selection requires a ${QUESTIONNAIRE_EMBEDDING_DIMENSION}-dim embedding model (matching the knowledge base).`
    );
  }

  // One UPDATE per slot — the column is Prisma-Unsupported, so no typed bulk path.
  for (let i = 0; i < targets.length; i++) {
    await prisma.$executeRawUnsafe(
      `UPDATE "app_data_slot" SET "embedding" = $1::vector WHERE "id" = $2`,
      toVectorLiteral(embeddings[i]),
      targets[i].id
    );
  }

  logger.info('Embedded questionnaire data slots', {
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

export interface DataSlotEmbeddingCoverage {
  /** Total data slots in the version. */
  total: number;
  /** Data slots that have an embedding. */
  embedded: number;
  /** Data slots still missing an embedding (`total - embedded`). */
  missing: number;
}

/**
 * Report how many of a version's data slots are embedded. Backs the admin "Generate embeddings"
 * status (data-slots variant) and the adaptive launch-gate check.
 */
export async function dataSlotEmbeddingCoverage(
  versionId: string
): Promise<DataSlotEmbeddingCoverage> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; embedded: bigint }>>(
    `SELECT count(*)::bigint AS total, count("embedding")::bigint AS embedded
       FROM "app_data_slot" WHERE "versionId" = $1`,
    versionId
  );
  const total = Number(rows[0]?.total ?? 0);
  const embedded = Number(rows[0]?.embedded ?? 0);
  return { total, embedded, missing: total - embedded };
}

/**
 * Lazily ensure a version's data slots are embedded for adaptive selection. Cheap no-op once
 * embedded (a single COUNT short-circuits), so it's safe to call on the live data-slot turn path;
 * embeds only the missing slots otherwise. Still throws if the embedder is misconfigured — callers
 * on the respondent hot path MUST wrap in try/catch so a failed embed degrades to the deterministic
 * topic-local pick rather than breaking the turn.
 */
export async function ensureVersionDataSlotsEmbedded(
  versionId: string
): Promise<EmbedVersionDataSlotsResult> {
  const rows = await prisma.$queryRawUnsafe<Array<{ missing: bigint }>>(
    `SELECT count(*)::bigint AS missing FROM "app_data_slot" WHERE "versionId" = $1 AND "embedding" IS NULL`,
    versionId
  );
  if (Number(rows[0]?.missing ?? 0) === 0) {
    return { embedded: 0, skipped: 0, total: 0 };
  }
  return embedVersionDataSlots(versionId, { onlyMissing: true });
}

/**
 * Rank `candidateIds` by cosine similarity to `embedding`, returning at most `k` data-slot ids
 * best-first. Only slots that actually have an embedding participate — an un-embedded version
 * yields `[]`, which the adaptive selection reads as its cue to fall back to the deterministic pick.
 */
export async function rankDataSlotsByVector(
  embedding: number[],
  candidateIds: string[],
  k: number
): Promise<string[]> {
  if (candidateIds.length === 0 || k <= 0) return [];
  // Expand the candidate ids into individual placeholders ($3, $4, …) rather than binding a JS
  // array to `ANY($n)` — mirrors `slot-embeddings.ts` / the knowledge hybrid-search query.
  const idPlaceholders = candidateIds.map((_, i) => `$${i + 3}`).join(', ');
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "app_data_slot"
     WHERE "id" IN (${idPlaceholders}) AND "embedding" IS NOT NULL
     ORDER BY ("embedding" <=> $1::vector) ASC
     LIMIT $2`,
    toVectorLiteral(embedding),
    k,
    ...candidateIds
  );
  return rows.map((r) => r.id);
}
