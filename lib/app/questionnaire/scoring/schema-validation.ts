/**
 * Scoring schema validation (report kind `cohort`, F14.4).
 *
 * {@link narrowScoringSchemaContent} defensively projects the stored/extracted `content` JSON onto a
 * complete {@link ScoringSchemaContent} (dropping malformed scales/items/bands and items that
 * reference an unknown scale). {@link scoringSchemaContentSchema} is the strict Zod the PUT route
 * validates the builder's payload against. Pure (Zod only).
 */

import { z } from 'zod';

import { SCORING_ITEM_SOURCES, SCORING_METHODS } from '@/lib/app/questionnaire/types';
import {
  EMPTY_SCORING_SCHEMA,
  type ScoringSchemaContent,
} from '@/lib/app/questionnaire/scoring/types';
import { isRecord } from '@/lib/utils';

const KEY_RE = /^[a-z0-9_]+$/;

/** Strict request schema for the visual builder's PUT (and the extract review save). */
export const scoringSchemaContentSchema = z
  .object({
    scales: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(60).regex(KEY_RE),
            name: z.string().trim().min(1).max(120),
            description: z.string().trim().max(500).optional(),
          })
          .strict()
      )
      .max(40),
    items: z
      .array(
        z
          .object({
            source: z.enum(SCORING_ITEM_SOURCES),
            ref: z.string().trim().min(1).max(120),
            scaleKey: z.string().trim().min(1).max(60),
            weight: z.number().finite().min(-10).max(10),
            reverse: z.boolean(),
          })
          .strict()
      )
      .max(500),
    bands: z
      .array(
        z
          .object({
            scaleKey: z.string().trim().min(1).max(60),
            min: z.number().finite(),
            max: z.number().finite(),
            label: z.string().trim().min(1).max(120),
          })
          .strict()
      )
      .max(200),
    method: z.enum(SCORING_METHODS),
    normalise: z.boolean().optional(),
  })
  .strict()
  .superRefine((schema, ctx) => {
    const scaleKeys = new Set(schema.scales.map((s) => s.key));
    if (scaleKeys.size !== schema.scales.length) {
      ctx.addIssue({ code: 'custom', message: 'Scale keys must be unique', path: ['scales'] });
    }
    schema.items.forEach((item, i) => {
      if (!scaleKeys.has(item.scaleKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `Item references unknown scale "${item.scaleKey}"`,
          path: ['items', i, 'scaleKey'],
        });
      }
    });
    schema.bands.forEach((band, i) => {
      if (!scaleKeys.has(band.scaleKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `Band references unknown scale "${band.scaleKey}"`,
          path: ['bands', i, 'scaleKey'],
        });
      }
      if (band.max < band.min) {
        ctx.addIssue({
          code: 'custom',
          message: 'Band max must be ≥ min',
          path: ['bands', i, 'max'],
        });
      }
    });

    // C8: normalising rescales what `raw` means, so cutoffs written in the questions' own units
    // stop matching anything. Left unchecked the author gets `band: null` on every respondent and
    // an empty band breakdown in the cohort report, with nothing anywhere saying why. Rejecting the
    // save is the only place that failure is still attributable to a cause.
    if (schema.normalise) {
      // Weight TOTAL per scale, not item count: `scoreSession` computes Σ(wᵢ·vᵢ), and with
      // normalisation each vᵢ lands in 0–1, so the ceiling under `sum` is Σwᵢ — which equals the
      // item count only when every weight is 1. Counting items instead rejected a correctly
      // authored 0–2N band set on a scale whose items carry weight 2.
      const weightPerScale = new Map<string, number>();
      for (const item of schema.items) {
        weightPerScale.set(item.scaleKey, (weightPerScale.get(item.scaleKey) ?? 0) + item.weight);
      }
      schema.bands.forEach((band, i) => {
        // A scale with no items mapped yet has no knowable ceiling. Skip it rather than compute 0
        // and reject every band: add-scale → add-band → map-items is the normal order in the
        // ScoringBuilder, so failing there blocks authoring mid-flow for a schema that is merely
        // unfinished. Once an item lands, the check applies.
        const scaleWeight = weightPerScale.get(band.scaleKey);
        if (schema.method === 'sum' && scaleWeight === undefined) return;
        const ceiling = schema.method === 'sum' ? (scaleWeight ?? 0) : 1;
        if (band.min < 0 || band.max > ceiling) {
          ctx.addIssue({
            code: 'custom',
            message:
              `With normalisation on, scores for this scale run 0–${ceiling}. Re-author this band's ` +
              `cutoffs in that range (they are currently ${band.min}–${band.max}).`,
            path: ['bands', i],
          });
        }
      });
    }
  });

/**
 * Defensively project stored/extracted JSON onto a complete {@link ScoringSchemaContent}. Unlike the
 * strict Zod (which rejects), this coerces + drops the unusable so a read path / aggregation never
 * throws on a legacy or partially-extracted schema: malformed entries are skipped, and items/bands
 * that reference an unknown scale are pruned.
 */
export function narrowScoringSchemaContent(value: unknown): ScoringSchemaContent {
  if (!isRecord(value)) return EMPTY_SCORING_SCHEMA;

  const scales = Array.isArray(value.scales)
    ? value.scales
        .filter(isRecord)
        .filter((s) => typeof s.key === 'string' && typeof s.name === 'string')
        .map((s) => ({
          key: s.key as string,
          name: s.name as string,
          description: typeof s.description === 'string' ? s.description : undefined,
        }))
    : [];
  const scaleKeys = new Set(scales.map((s) => s.key));

  const items = Array.isArray(value.items)
    ? value.items
        .filter(isRecord)
        .filter(
          (i) =>
            (i.source === 'question' || i.source === 'dataSlot') &&
            typeof i.ref === 'string' &&
            typeof i.scaleKey === 'string' &&
            scaleKeys.has(i.scaleKey)
        )
        .map((i) => ({
          source: i.source as 'question' | 'dataSlot',
          ref: i.ref as string,
          scaleKey: i.scaleKey as string,
          weight: typeof i.weight === 'number' && Number.isFinite(i.weight) ? i.weight : 1,
          reverse: i.reverse === true,
        }))
    : [];

  const bands = Array.isArray(value.bands)
    ? value.bands
        .filter(isRecord)
        .filter(
          (b) =>
            typeof b.scaleKey === 'string' &&
            scaleKeys.has(b.scaleKey) &&
            typeof b.min === 'number' &&
            typeof b.max === 'number' &&
            typeof b.label === 'string'
        )
        .map((b) => ({
          scaleKey: b.scaleKey as string,
          min: b.min as number,
          max: b.max as number,
          label: b.label as string,
        }))
    : [];

  const method = value.method === 'sum' ? 'sum' : 'mean';

  // Absent reads as OFF, which is the truth for every schema authored before C8 existed — and the
  // only reading that leaves their stored scores meaning what they meant when they were computed.
  const normalise = value.normalise === true;

  return { scales, items, bands, method, normalise };
}
