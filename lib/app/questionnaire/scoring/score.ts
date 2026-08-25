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

/**
 * The numeric bounds of an item's source question.
 *
 * Two jobs, and the second is why a missing entry matters more than it used to: reverse-scoring
 * (`(min + max) - value`), and — when the schema sets `normalise` — placing the item on a common
 * 0–1 ruler. An item with no bounds is simply not reversed; under `normalise` it cannot be placed
 * at all, and is dropped.
 */
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
function bandPosition(bands: ScoringBand[], scaleKey: string, raw: number): number | null {
  const scaleBands = bands.filter((b) => b.scaleKey === scaleKey);
  if (scaleBands.length === 0) return null;
  const lo = Math.min(...scaleBands.map((b) => b.min));
  const hi = Math.max(...scaleBands.map((b) => b.max));
  if (hi <= lo) return null;
  return Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
}

/**
 * Score one respondent's answers against a scoring schema. `answers` maps an item `ref`
 * (question/data-slot key) to its numeric value; `bounds` supplies min/max per ref for
 * reverse-scoring (a ref without bounds is not reversed). Only scales with at least one answered item
 * appear in the result.
 *
 * `schema.normalise` (C8) puts every item on a common ruler before combining: each value becomes its
 * 0–1 position within its own question's bounds. Without it, a scale drawing on a 1–6 battery and a
 * 1–5 one is arithmetic over two different rulers — a 4 of 5 and a 4 of 6 are not the same quantity,
 * and a 0–50 numeric beside a likert decides the scale on its own. An item with no bounds cannot be
 * placed on that ruler, so under `normalise` it is DROPPED rather than passed through in its raw
 * units, which would silently reintroduce the exact mixing the flag exists to prevent. The drop is
 * visible as `itemCount` falling short of `totalItemCount`, and the authoring route warns about it
 * before a schema is saved.
 *
 * `inScopeRefs` — Conditional Topics (P17) — is the set of item refs this respondent's interview
 * actually covered. It does NOT change any arithmetic: an item outside scope has no answer, so it
 * was already being skipped. What it changes is the *record*, by separating "they were asked and
 * did not answer" from "the instrument never asked them". Omit it (or pass null) and every item
 * counts as asked, which is the truth for every non-adaptive session.
 */
export function scoreSession(
  schema: ScoringSchemaContent,
  answers: Map<string, number>,
  bounds: Map<string, ItemBounds>,
  inScopeRefs?: ReadonlySet<string> | null
): RespondentScores {
  const result: RespondentScores = {};

  for (const scale of schema.scales) {
    const items = schema.items.filter((i) => i.scaleKey === scale.key);
    let weightedSum = 0;
    let weightTotal = 0;
    let itemCount = 0;
    let assessedItemCount = 0;

    for (const item of items) {
      if (!inScopeRefs || inScopeRefs.has(item.ref)) assessedItemCount += 1;
      const value = answers.get(item.ref);
      if (value === undefined || !Number.isFinite(value)) continue;
      const b = bounds.get(item.ref);
      let v = value;
      // Reverse in the question's own units. The two orders happen to agree arithmetically —
      // reversing then rescaling and rescaling then flipping both give (max - v) / (max - min) —
      // so this order is chosen because reversal is *defined* in those units, not to fix a bug.
      if (item.reverse && b) v = b.min + b.max - v;
      if (schema.normalise) {
        if (!b || b.max === b.min) continue;
        v = (v - b.min) / (b.max - b.min);
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
      normalised: bandPosition(schema.bands, scale.key, raw),
      band: bandFor(schema.bands, scale.key, raw),
      itemCount,
      assessedItemCount,
      totalItemCount: items.length,
    };
    result[scale.key] = score;
  }

  return result;
}
