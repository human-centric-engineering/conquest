/**
 * Extraction candidate pre-filter (answer-mapping at scale) — the impure seam.
 *
 * The combined extractor is handed the FULL candidate list every turn: all question slots + all data
 * slots, rendered into the prompt by `extraction-prompt.ts`. At 50+ data slots / 70+ questions that's
 * thousands of candidate tokens per turn. This narrows the set to the slots that actually matter plus
 * the top-K most similar to the respondent's last message (pgvector, the same model as adaptive
 * selection) — the extraction sibling of `data-slot-selection.ts`.
 *
 * It is **behaviour-preserving by design**: the extractor re-scans EVERY slot today so an off-topic
 * answer still lands and a later message can enrich an already-filled slot from another theme. The
 * narrowing keeps those guarantees via hard safety rails (below) and is **fail-soft** — no last
 * message, an embed error, or an un-embedded version all return the FULL set rather than a partial
 * narrowing that could silently drop a slot. The sub-flag gate is enforced upstream (the route only
 * narrows when the feature is on).
 *
 * Mirrors `data-slot-selection.ts`: direct imports of the embedder + rankers (mocked in tests), one
 * `embedText` call reused for both rankings, pure assembly.
 */

import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { logger } from '@/lib/logging';
import {
  rankSlotsByVector,
  rankSlotsByText,
  findDuplicateSlotIds,
} from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import {
  rankDataSlotsByVector,
  rankDataSlotsByText,
} from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { buildEmbeddingTrace, type RecordAgentCall } from '@/lib/app/questionnaire/inspector';

/** Tuning knobs. All overridable per-call so tests can pin small values and ops can tune. */
export const EXTRACTION_PREFILTER_DEFAULTS = {
  /** Top-K most similar question slots to keep (beyond the forced safety-rail set). */
  questionK: 40,
  /** Top-K most similar data slots to keep (generous vs. the selector's 8 — extraction fills many per turn). */
  dataSlotK: 18,
  /** Below this combined candidate count the pre-filter is a no-op (send everything). */
  sizeThreshold: 30,
  /**
   * Cosine DISTANCE under which a candidate question counts as a near-duplicate of a kept one
   * (similarity ≥ 0.93) — the twin-inclusion rail pulls those siblings in so a clear answer lands on
   * every copy of a repeated question, not just the one the ranking surfaced.
   */
  duplicateMaxDistance: 0.07,
} as const;

/** A data-slot candidate, as the route assembles it (identity, theme, mapping, current-fill marker). */
export interface DataSlotCandidateInput {
  id: string;
  key: string;
  name: string;
  description: string;
  theme: string;
  mappedQuestionKeys?: string[];
  /** True when this slot already has a recorded fill — cross-turn enrichment depends on always re-scanning it. */
  hasCurrentFill: boolean;
}

export interface ExtractionCandidateInput {
  /** ALL question slots for the version (loaded.slots). */
  questionSlots: CapabilitySlotView[];
  /** ALL data slots for the version (assembled from loaded.base.dataSlots). */
  dataSlots: DataSlotCandidateInput[];
  /** The active question slot key (loaded.activeQuestionKey) — always retained. */
  activeQuestionKey: string | null;
  /** The active data-slot key (data-slot mode) — always retained. */
  activeDataSlotKey: string | null;
  /** Theme the turn is exploring — same-theme unfilled data slots are always retained. */
  activeTheme: string | null;
  /** Recent transcript, oldest → newest; the last entry seeds the similarity query. */
  recentMessages: string[];
  sessionId: string;
  questionK?: number;
  dataSlotK?: number;
  sizeThreshold?: number;
  /** Inspector sink (admin preview only); when present, a successful embed records one trace. */
  recordInspectorCall?: RecordAgentCall;
}

export type ExtractionPrefilterReason =
  | 'below_threshold'
  | 'no_message'
  | 'embed_failed'
  | 'no_embeddings'
  | 'narrowed';

export interface ExtractionCandidateResult {
  /** Narrowed question slots — a SUBSET of the input, original order preserved. */
  questionSlots: CapabilitySlotView[];
  /** Narrowed data slots — a SUBSET of the input (same objects), original order preserved. */
  dataSlots: DataSlotCandidateInput[];
  /** False when the full set was returned unchanged (no-op / fail-soft). */
  applied: boolean;
  reason: ExtractionPrefilterReason;
  questionsIn: number;
  questionsOut: number;
  dataSlotsIn: number;
  dataSlotsOut: number;
}

/**
 * Narrow the extractor's candidate set for one turn. Returns subsets of the inputs (original order
 * preserved) plus diagnostics. Never throws — any failure returns the full set.
 *
 * Safety rails (always retained regardless of similarity):
 *  1. the active question + active data slot;
 *  2. EVERY data slot that already has a current fill (cross-turn enrichment);
 *  3. same-theme UNFILLED data slots (topic-local rhythm);
 *  4. the mapped questions of every KEPT data slot (forward propagation to form questions).
 */
export async function narrowExtractionCandidates(
  input: ExtractionCandidateInput
): Promise<ExtractionCandidateResult> {
  const questionK = input.questionK ?? EXTRACTION_PREFILTER_DEFAULTS.questionK;
  const dataSlotK = input.dataSlotK ?? EXTRACTION_PREFILTER_DEFAULTS.dataSlotK;
  const duplicateMaxDistance = EXTRACTION_PREFILTER_DEFAULTS.duplicateMaxDistance;
  const sizeThreshold = input.sizeThreshold ?? EXTRACTION_PREFILTER_DEFAULTS.sizeThreshold;

  const full = (reason: ExtractionPrefilterReason): ExtractionCandidateResult => ({
    questionSlots: input.questionSlots,
    dataSlots: input.dataSlots,
    applied: false,
    reason,
    questionsIn: input.questionSlots.length,
    questionsOut: input.questionSlots.length,
    dataSlotsIn: input.dataSlots.length,
    dataSlotsOut: input.dataSlots.length,
  });

  // (A) Size gate — small/medium questionnaires keep the full re-scan (cheaper than embedding + safer).
  if (input.questionSlots.length + input.dataSlots.length < sizeThreshold) {
    return full('below_threshold');
  }

  // (B) No message to rank against (e.g. an opening turn) — send everything.
  const lastMessage = input.recentMessages[input.recentMessages.length - 1]?.trim();
  if (!lastMessage) return full('no_message');

  try {
    const startedAt = Date.now();
    const embedResult = await embedText(lastMessage, 'query');
    const embedLatencyMs = Date.now() - startedAt;
    const embedding = embedResult.embedding;

    // ---- Data slots ----
    // Rails 1-3: always keep the active slot, every filled slot (any theme), and same-theme unfilled.
    const forcedDataKeys = new Set<string>();
    for (const ds of input.dataSlots) {
      if (ds.hasCurrentFill) forcedDataKeys.add(ds.key); // rail 2 — cross-turn enrichment
      if (input.activeDataSlotKey && ds.key === input.activeDataSlotKey) forcedDataKeys.add(ds.key); // rail 1
      if (input.activeTheme && ds.theme === input.activeTheme) forcedDataKeys.add(ds.key); // rail 3
    }

    // Hybrid retrieval: UNION the dense (vector) top-K with the lexical (BM25) top-K, so an exact
    // term the respondent used surfaces its slot even when a multi-topic message dilutes the dense
    // vector. The un-embedded fail-soft bails on the DENSE result (the embedding being absent), not
    // the union — lexical alone is too sparse to safely narrow on.
    const dataIds = input.dataSlots.map((s) => s.id);
    const [denseDataIds, lexicalDataIds] = await Promise.all([
      rankDataSlotsByVector(embedding, dataIds, dataSlotK),
      rankDataSlotsByText(lastMessage, dataIds, dataSlotK),
    ]);
    // Un-embedded version (no dense rows) → fail-soft to the full set so we never drop a slot.
    // (When there are genuinely no data slots, there's nothing to drop and the question side still
    // narrows — so only bail when data slots EXIST but none are embedded.)
    if (input.dataSlots.length > 0 && denseDataIds.length === 0) return full('no_embeddings');
    const rankedDataIds = [...new Set([...denseDataIds, ...lexicalDataIds])];

    const dataById = new Map(input.dataSlots.map((s) => [s.id, s]));
    const rankedDataKeys = new Set(
      rankedDataIds.map((id) => dataById.get(id)?.key).filter((k): k is string => k !== undefined)
    );
    const keptDataSlots = input.dataSlots.filter(
      (s) => forcedDataKeys.has(s.key) || rankedDataKeys.has(s.key)
    );

    // ---- Question slots ----
    // Rail 1: active question. Rail 4: mapped questions of the KEPT data slots (not the dropped ones).
    const forcedQuestionKeys = new Set<string>();
    if (input.activeQuestionKey) forcedQuestionKeys.add(input.activeQuestionKey);
    for (const ds of keptDataSlots) {
      for (const qk of ds.mappedQuestionKeys ?? []) forcedQuestionKeys.add(qk);
    }

    // Hybrid retrieval for questions too: dense top-K ∪ lexical top-K.
    const questionIds = input.questionSlots.map((s) => s.id);
    const [denseQuestionIds, lexicalQuestionIds] = await Promise.all([
      rankSlotsByVector(embedding, questionIds, questionK),
      rankSlotsByText(lastMessage, questionIds, questionK),
    ]);
    const rankedQuestionIds = [...new Set([...denseQuestionIds, ...lexicalQuestionIds])];
    const questionById = new Map(input.questionSlots.map((s) => [s.id, s]));
    const rankedQuestionKeys = new Set(
      rankedQuestionIds
        .map((id) => questionById.get(id)?.key)
        .filter((k): k is string => k !== undefined)
    );
    const keptQuestionKeys = new Set<string>();
    for (const s of input.questionSlots) {
      if (forcedQuestionKeys.has(s.key) || rankedQuestionKeys.has(s.key))
        keptQuestionKeys.add(s.key);
    }

    // Twin-inclusion rail: pull in near-duplicate copies of any KEPT question (the same question
    // reworded in another section) so a clear answer lands on EVERY copy, not just the one the
    // ranking surfaced. Embedding self-similarity, capped — a no-op when the version has no twins.
    const keptQuestionIds = input.questionSlots
      .filter((s) => keptQuestionKeys.has(s.key))
      .map((s) => s.id);
    const duplicateIds = await findDuplicateSlotIds(
      keptQuestionIds,
      questionIds,
      duplicateMaxDistance
    );
    for (const id of duplicateIds) {
      const key = questionById.get(id)?.key;
      if (key) keptQuestionKeys.add(key);
    }

    const keptQuestionSlots = input.questionSlots.filter((s) => keptQuestionKeys.has(s.key));

    input.recordInspectorCall?.(
      buildEmbeddingTrace({
        label: 'Extraction candidate ranking',
        embedded: lastMessage,
        rankingSummary:
          `Ranked ${input.questionSlots.length} questions → kept ${keptQuestionSlots.length}, ` +
          `${input.dataSlots.length} data slots → kept ${keptDataSlots.length} ` +
          `(top-K + safety rails).`,
        model: embedResult.model,
        provider: embedResult.provider,
        dimensions: embedResult.dimensions,
        inputTokens: embedResult.inputTokens,
        costUsd: embedResult.costUsd,
        latencyMs: embedLatencyMs,
      })
    );

    return {
      questionSlots: keptQuestionSlots,
      dataSlots: keptDataSlots,
      applied: true,
      reason: 'narrowed',
      questionsIn: input.questionSlots.length,
      questionsOut: keptQuestionSlots.length,
      dataSlotsIn: input.dataSlots.length,
      dataSlotsOut: keptDataSlots.length,
    };
  } catch (err) {
    logger.warn('Extraction pre-filter failed; sending full candidate set', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return full('embed_failed');
  }
}
