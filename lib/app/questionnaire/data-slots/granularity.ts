/**
 * Data-slot generation granularity — the admin-chosen knob that controls how many
 * slots the generator aims for and how broad/fine each one is.
 *
 * Five ordered levels, "balanced" in the middle as the default. Broader levels
 * consolidate many questions into a few high-level slots; finer levels split
 * distinct facets out, approaching a 1:1 mapping with the questions. The `guidance`
 * string is injected verbatim into the generation prompt. Pure (only `zod`) so the
 * capability, prompt builder, route, and client all share one source of truth.
 */

import { z } from 'zod';

export interface DataSlotGranularityLevel {
  value: DataSlotGranularity;
  /** Short control label. */
  label: string;
  /** One-line description shown under the control. */
  summary: string;
  /** Instruction injected into the generation prompt for this level. */
  guidance: string;
}

export type DataSlotGranularity = 'broadest' | 'broad' | 'balanced' | 'granular' | 'finest';

export const DEFAULT_DATA_SLOT_GRANULARITY: DataSlotGranularity = 'balanced';

/** Ordered broad → fine. The middle entry is the default. */
export const DATA_SLOT_GRANULARITY_LEVELS: readonly DataSlotGranularityLevel[] = [
  {
    value: 'broadest',
    label: 'Broadest',
    summary: 'Fewest slots — only the major themes, each spanning many questions.',
    guidance:
      'Consolidate aggressively. Produce the smallest viable set of broad, high-level slots, ' +
      'each abstracting over many related questions. Only genuinely distinct top-level themes ' +
      'earn their own slot.',
  },
  {
    value: 'broad',
    label: 'Broad',
    summary: 'Fewer, more general slots.',
    guidance:
      'Favour consolidation. Group related questions into broad slots; create a new slot only ' +
      'when a theme is clearly distinct from the others.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    summary: 'A sensible middle ground — one slot per coherent topic. Recommended.',
    guidance:
      'Balance breadth and detail. Create one slot per coherent topic: consolidate closely ' +
      'related questions, but split genuinely separate concerns into their own slots.',
  },
  {
    value: 'granular',
    label: 'Granular',
    summary: 'More, finer slots — distinct facets split out.',
    guidance:
      'Favour granularity. Split distinct facets into their own slots; consolidate only ' +
      'near-duplicate questions that ask the same thing.',
  },
  {
    value: 'finest',
    label: 'Finest',
    summary: 'Most slots — one per distinct facet, near 1:1 with the questions.',
    guidance:
      'Maximise granularity. Give each distinct intent its own slot, approaching a 1:1 mapping ' +
      'with the questions; consolidate only true duplicates.',
  },
];

export const dataSlotGranularitySchema = z
  .enum(['broadest', 'broad', 'balanced', 'granular', 'finest'])
  .default(DEFAULT_DATA_SLOT_GRANULARITY);

/** The prompt instruction for a level, falling back to the default level's guidance. */
export function granularityGuidance(value: DataSlotGranularity): string {
  const level =
    DATA_SLOT_GRANULARITY_LEVELS.find((l) => l.value === value) ??
    DATA_SLOT_GRANULARITY_LEVELS.find((l) => l.value === DEFAULT_DATA_SLOT_GRANULARITY);
  return level?.guidance ?? '';
}
