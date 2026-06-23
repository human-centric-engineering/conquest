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
}

/** Empty schema — the lazy default when none is authored. */
export const EMPTY_SCORING_SCHEMA: ScoringSchemaContent = {
  scales: [],
  items: [],
  bands: [],
  method: 'mean',
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
}

/** A respondent's scores keyed by scale, stored in `AppRespondentScore.scores`. */
export type RespondentScores = Record<string, ScaleScore>;
