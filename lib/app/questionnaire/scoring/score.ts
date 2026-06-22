/**
 * Deterministic scoring engine (report kind `cohort`, F14.4) — pure, no I/O.
 *
 * `scoreSession` turns one respondent's numeric answers into per-scale scores + bands under a
 * {@link ScoringSchemaContent}: it applies reverse-scoring (on each item's likert bounds), weights,
 * the scale's combine method (weighted sum or mean), and the band cutoffs. The "hard rules" heart of
 * the feature — fully deterministic, so it's unit-tested directly and produces the same result on
 * the server, in aggregation, and in the cohort report.
 */

import type {
  RespondentScores,
  ScaleScore,
  ScoringBand,
  ScoringSchemaContent,
} from '@/lib/app/questionnaire/scoring/types';

/** The numeric bounds of an item's source question (for reverse-scoring). */
export interface ItemBounds {
  min: number;
  max: number;
}

/** Find the band a raw score falls into for a scale (inclusive ranges); null when none match. */
function bandFor(bands: ScoringBand[], scaleKey: string, raw: number): string | null {
  for (const b of bands) {
    if (b.scaleKey === scaleKey && raw >= b.min && raw <= b.max) return b.label;
  }
  return null;
}

/** The 0–1 position of `raw` within a scale's overall band span; null when the scale has no bands. */
function normalise(bands: ScoringBand[], scaleKey: string, raw: number): number | null {
  const scaleBands = bands.filter((b) => b.scaleKey === scaleKey);
  if (scaleBands.length === 0) return null;
  const lo = Math.min(...scaleBands.map((b) => b.min));
  const hi = Math.max(...scaleBands.map((b) => b.max));
  if (hi <= lo) return null;
  return Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
}

/**
 * Score one respondent's answers against a scoring schema. `answers` maps an item `ref`
 * (question/data-slot key) to its numeric value; `bounds` supplies likert min/max per ref for
 * reverse-scoring (a ref without bounds is not reversed). Only scales with at least one answered item
 * appear in the result.
 */
export function scoreSession(
  schema: ScoringSchemaContent,
  answers: Map<string, number>,
  bounds: Map<string, ItemBounds>
): RespondentScores {
  const result: RespondentScores = {};

  for (const scale of schema.scales) {
    const items = schema.items.filter((i) => i.scaleKey === scale.key);
    let weightedSum = 0;
    let weightTotal = 0;
    let itemCount = 0;

    for (const item of items) {
      const value = answers.get(item.ref);
      if (value === undefined || !Number.isFinite(value)) continue;
      let v = value;
      if (item.reverse) {
        const b = bounds.get(item.ref);
        if (b) v = b.min + b.max - v;
      }
      const w = Number.isFinite(item.weight) ? item.weight : 1;
      weightedSum += w * v;
      weightTotal += w;
      itemCount += 1;
    }

    if (itemCount === 0) continue;

    const raw =
      schema.method === 'sum' ? weightedSum : weightTotal !== 0 ? weightedSum / weightTotal : 0;
    const score: ScaleScore = {
      raw,
      normalised: normalise(schema.bands, scale.key, raw),
      band: bandFor(schema.bands, scale.key, raw),
      itemCount,
    };
    result[scale.key] = score;
  }

  return result;
}
