/**
 * Deterministic scoring schema — client-safe types (report kind `cohort`, F14.4).
 *
 * The "hard rules" an admin defines so a questionnaire scores like a psychometric instrument
 * (e.g. Big Five): named scales, a mapping of question/data-slot answers onto scales (with weight +
 * reverse-scoring), a combine method, and band cutoffs that turn a score into a label. Authored in
 * the visual builder or extracted from an uploaded document — one schema model either way. Pure
 * types (no Prisma, no Next).
 */

import type { ScoringItemSource, ScoringMethod } from '@/lib/app/questionnaire/types';

/** A named scale (dimension) a respondent is scored on. */
export interface ScoringScale {
  /** Stable slug, unique within the schema. */
  key: string;
  name: string;
  description?: string;
}

/** One contribution to a scale: a question/data-slot answer, weighted, optionally reverse-scored. */
export interface ScoringItem {
  /** Whether `ref` is a question slot key or a data slot key. */
  source: ScoringItemSource;
  /** The `AppQuestionSlot.key` or `AppDataSlot.key` whose numeric answer feeds the scale. */
  ref: string;
  scaleKey: string;
  /** Multiplier applied to the (possibly reversed) value. Default 1. */
  weight: number;
  /** Reverse-score on the item's likert bounds: `(min + max) - value`. */
  reverse: boolean;
}

/** A band: the score range `[min, max]` (inclusive) on a scale that maps to `label`. */
export interface ScoringBand {
  scaleKey: string;
  min: number;
  max: number;
  label: string;
}

/** The full structured scoring schema stored in `AppScoringSchema.content`. */
export interface ScoringSchemaContent {
  scales: ScoringScale[];
  items: ScoringItem[];
  bands: ScoringBand[];
  /** How each scale combines its items: weighted sum or weighted mean. */
  method: ScoringMethod;
  /**
   * Put every item on the same ruler before combining it — map each answer to its 0–1 position
   * within its OWN question's bounds (C8 / guardrail G06).
   *
   * Off by default, and that default is load-bearing: turning it on changes what `raw` means, so
   * every schema authored before this existed keeps its values exactly. Turn it on when one scale
   * draws items from questions with different ranges — a 1–6 agreement battery beside a 1–5 extent
   * one, or a 0–50 numeric beside either. Without it, `scoreSession` averages the numbers as
   * written: a 4 out of 5 (75% of the way up) and a 4 out of 6 (60%) are treated as the same
   * quantity, and a 0–50 numeric swamps the likerts it sits with. The result is a number, and
   * nothing about it says it is meaningless.
   *
   * Two consequences the author must know, both surfaced rather than absorbed:
   * an item whose question has no numeric bounds cannot be placed on the ruler and is DROPPED from
   * the scale (see `scoreSession`); and `raw` lands in 0–1 under `mean`, so band cutoffs written in
   * the old units match nothing — {@link scoringSchemaContentSchema} rejects those rather than
   * letting every band silently read `null`.
   */
  normalise?: boolean;
}

/** Empty schema — the lazy default when none is authored. */
export const EMPTY_SCORING_SCHEMA: ScoringSchemaContent = {
  scales: [],
  items: [],
  bands: [],
  method: 'mean',
  normalise: false,
};

/** One scale's computed result for a respondent. */
export interface ScaleScore {
  /** The combined raw score (sum or mean of weighted item values). */
  raw: number;
  /** 0–1 position of `raw` within the scale's observed min/max band span (null when no bands). */
  normalised: number | null;
  /** The band label `raw` falls into, or null when no band matches. */
  band: string | null;
  /** How many items contributed (answered). */
  itemCount: number;
  /**
   * How many of the scale's items this respondent was actually ASKED — Adaptive Scope (P17).
   *
   * Equal to {@link totalItemCount} for every non-adaptive session, and for an adaptive one whose
   * plan happened to cover the whole scale. Lower when the interview deliberately skipped part of
   * it.
   *
   * Optional so a score row written before P17 still narrows: absent reads as "everything was
   * asked", which is exactly what was true then.
   */
  assessedItemCount?: number;
  /** How many items the schema defines for this scale, regardless of scope or answers. */
  totalItemCount?: number;
}

/**
 * Whether a scale score was computed over a NARROWED instrument — Adaptive Scope (P17).
 *
 * The load-bearing distinction for any comparison. A band derived from three of a scale's eight
 * items is not the same measurement as one derived from all eight, and a cohort chart that puts
 * them in the same column is comparing two different instruments while looking like it is not.
 * Every surface that renders a band must be able to ask this question, so it lives beside the type
 * rather than being re-derived at each one.
 */
export function isPartiallyAssessed(score: ScaleScore): boolean {
  if (score.assessedItemCount === undefined || score.totalItemCount === undefined) return false;
  return score.assessedItemCount < score.totalItemCount;
}

/** A respondent's scores keyed by scale, stored in `AppRespondentScore.scores`. */
export type RespondentScores = Record<string, ScaleScore>;
