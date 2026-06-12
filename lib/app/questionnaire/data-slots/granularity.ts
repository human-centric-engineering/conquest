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
  /**
   * Target slot count as a fraction of the question count — the range the generator
   * aims for. A *target band*, not a hard cap: content can justify landing slightly
   * outside it. e.g. balanced ≈ 0.45–0.55 → about half as many slots as questions.
   */
  ratio: { min: number; max: number };
}

export type DataSlotGranularity = 'broadest' | 'broad' | 'balanced' | 'granular' | 'finest';

export const DEFAULT_DATA_SLOT_GRANULARITY: DataSlotGranularity = 'balanced';

/** Ordered broad → fine. The middle entry is the default. */
export const DATA_SLOT_GRANULARITY_LEVELS: readonly DataSlotGranularityLevel[] = [
  {
    value: 'broadest',
    label: 'Broadest',
    summary: 'Fewest slots — only the major themes (~1 slot per 5 questions).',
    guidance:
      'Consolidate aggressively. Produce the smallest viable set of broad, high-level slots, ' +
      'each abstracting over many related questions. Only genuinely distinct top-level themes ' +
      'earn their own slot.',
    ratio: { min: 0.15, max: 0.25 },
  },
  {
    value: 'broad',
    label: 'Broad',
    summary: 'Fewer, broader slots (~1 slot per 3 questions).',
    guidance:
      'Favour consolidation. Group related questions into broad slots; create a new slot only ' +
      'when a theme is clearly distinct from the others.',
    ratio: { min: 0.3, max: 0.4 },
  },
  {
    value: 'balanced',
    label: 'Balanced',
    summary: 'About half as many slots as questions — related questions grouped. Recommended.',
    guidance:
      'Balance breadth and detail. Consolidate closely related questions so the set lands near ' +
      'half the question count — but split genuinely separate concerns into their own slots.',
    ratio: { min: 0.45, max: 0.55 },
  },
  {
    value: 'granular',
    label: 'Granular',
    summary: 'More, finer slots — distinct facets split out (~3 slots per 4 questions).',
    guidance:
      'Favour granularity. Split distinct facets into their own slots; consolidate only ' +
      'near-duplicate questions that ask the same thing.',
    ratio: { min: 0.62, max: 0.8 },
  },
  {
    value: 'finest',
    label: 'Finest',
    summary: 'Most slots — close to one per question.',
    guidance:
      'Maximise granularity. Give each distinct intent its own slot, approaching a 1:1 mapping ' +
      'with the questions; consolidate only true duplicates.',
    ratio: { min: 0.85, max: 1.0 },
  },
];

export const dataSlotGranularitySchema = z
  .enum(['broadest', 'broad', 'balanced', 'granular', 'finest'])
  .default(DEFAULT_DATA_SLOT_GRANULARITY);

function levelFor(value: DataSlotGranularity): DataSlotGranularityLevel {
  return (
    DATA_SLOT_GRANULARITY_LEVELS.find((l) => l.value === value) ??
    DATA_SLOT_GRANULARITY_LEVELS.find((l) => l.value === DEFAULT_DATA_SLOT_GRANULARITY) ??
    DATA_SLOT_GRANULARITY_LEVELS[2]
  );
}

/** The prompt instruction for a level, falling back to the default level's guidance. */
export function granularityGuidance(value: DataSlotGranularity): string {
  return levelFor(value).guidance;
}

/**
 * The concrete slot-count band the generator should aim for, given how many questions
 * it's covering. Used to put a *number* in the prompt (qualitative guidance alone drifts
 * toward 1:1). `min` is floored at 1; `max` is at least `min` and never exceeds the
 * question count. For per-section calls pass that section's count; for the merge/single
 * call pass the total.
 */
export function targetSlotRange(
  value: DataSlotGranularity,
  questionCount: number
): { min: number; max: number } {
  const { ratio } = levelFor(value);
  const min = Math.max(1, Math.round(ratio.min * questionCount));
  const max = Math.min(questionCount, Math.max(min, Math.round(ratio.max * questionCount)));
  return { min, max };
}
