/**
 * Data-slot generation granularity — the admin-chosen knob that controls how many
 * slots the generator aims for and how broad/fine each one is.
 *
 * Five ordered levels, "balanced" in the middle as the default. Broader levels
 * consolidate many questions into a few high-level slots; finer levels split
 * distinct facets out, approaching a 1:1 mapping with the questions. The `guidance`
 * string is injected verbatim into the generation prompt. Pure (only `zod`) so the
 * capability, prompt builder, route, and client all share one source of truth.
 *
 * Each level's slot-count band is a STARTING POINT, not a fixed ratio: the material
 * moves it. See {@link ConsolidationProfile} — a set of sibling questions justifies
 * broader slots than a set of distinct ones, so the same "balanced" choice lands in
 * different places depending on what the questionnaire actually asks.
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
   *
   * This is the band BEFORE the content adjustment. {@link targetSlotRange} interpolates
   * it toward an adjacent level's band using a {@link ConsolidationProfile}, so the same
   * level lands finer on a set of distinct questions than on a battery of siblings.
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
    summary:
      'Related questions grouped — around half as many slots as questions, fewer or more ' +
      'depending on how similar the questions are. Recommended.',
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
 * How consolidatable THIS questionnaire's content actually is — the content-derived
 * adjustment to the admin's granularity choice.
 *
 * A fixed ratio per level ignores the material: "balanced" squeezed a set of thirty
 * distinct qualitative questions into the same ~half-count as a thirty-item likert
 * battery, and over-consolidation is what produces slots that can't be filled coherently
 * (see `.context/app/questionnaire/data-slots.md`). Two signals move the band:
 *
 *  - **Semantic cohesion** — how close each question sits to its nearest sibling. Lots of
 *    near-neighbours means broad slots are genuinely justified; a set where every question
 *    stands alone should land finer.
 *  - **Free-text share** — free-text questions RESIST consolidation structurally, and this
 *    is deliberately independent of similarity. A data-slot fill records ONE position, and
 *    down-propagation has one paraphrase to give; ten similar likert items collapse into
 *    one slot because each still maps onto its OWN scale point, whereas three similar
 *    free-text questions ("what do ego and Higher Self mean to you?", "how does your ego
 *    express itself?", "how does your Higher Self express itself?") need three slots
 *    despite embedding almost identically. Measuring cohesion over free text would push
 *    exactly the wrong way — hence {@link consolidationIndex} weights the semantic signal
 *    by the TYPED share and lets free text pull finer on its own.
 */
export interface ConsolidationProfile {
  /** Questions in scope (a section for the map step, the whole set for the merge). */
  questionCount: number;
  /** Fraction of those questions that are `free_text` (0–1). */
  freeTextShare: number;
  /**
   * Mean cosine similarity of each TYPED question to its nearest typed sibling, or `null` when
   * it could not be measured (no embeddings, or fewer than two typed questions). Null simply
   * drops the semantic term — the free-text signal still applies.
   *
   * Realistically lands in ~0.4–0.9; the domain is cosine's full −1…1 and anything outside the
   * anchors clamps, so out-of-band input degrades to the nearest extreme rather than needing a
   * guard at the call site.
   */
  cohesion: number | null;
}

/**
 * Cohesion at or below this reads as "every question stands alone" — the semantic signal
 * pulls fully finer. Cosine similarity between short prompts within one questionnaire is
 * high in absolute terms, so the useful band sits well above zero.
 */
export const LOW_COHESION_ANCHOR = 0.55;
/** Cohesion at or above this reads as "these questions are siblings" — pulls fully broader. */
export const HIGH_COHESION_ANCHOR = 0.8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Build a profile from the questions in scope plus an optional measured cohesion. */
export function buildConsolidationProfile(
  questions: readonly { type: string }[],
  cohesion: number | null = null
): ConsolidationProfile {
  const questionCount = questions.length;
  const freeText = questions.filter((q) => q.type === 'free_text').length;
  return {
    questionCount,
    freeTextShare: questionCount > 0 ? freeText / questionCount : 0,
    cohesion,
  };
}

/**
 * The content-derived shift, `-1` (pull fully toward the next FINER level) to `+1` (pull
 * fully toward the next BROADER level). `0` leaves the admin's chosen band untouched.
 *
 * The semantic term is weighted by the typed share and the free-text term is a flat pull
 * finer, so the extremes behave the way the material does: an all-likert set of siblings
 * → `+1`; an all-likert set of unrelated questions → `-1`; an all-free-text set → `-1`
 * regardless of how similar its questions look; a mixed set whose typed half is cohesive
 * → near `0`.
 */
export function consolidationIndex(profile: ConsolidationProfile): number {
  const freeTextShare = clamp(profile.freeTextShare, 0, 1);
  const typedShare = 1 - freeTextShare;

  const semanticPull =
    profile.cohesion === null
      ? 0
      : clamp(
          ((profile.cohesion - LOW_COHESION_ANCHOR) /
            (HIGH_COHESION_ANCHOR - LOW_COHESION_ANCHOR)) *
            2 -
            1,
          -1,
          1
        );

  return clamp(typedShare * semanticPull - freeTextShare, -1, 1);
}

/**
 * The concrete slot-count band the generator should aim for, given how many questions
 * it's covering. Used to put a *number* in the prompt (qualitative guidance alone drifts
 * toward 1:1). `min` is floored at 1; `max` is at least `min` and never exceeds the
 * question count. For per-section calls pass that section's count; for the merge/single
 * call pass the total.
 *
 * With a `profile`, the band is interpolated toward an ADJACENT level's band by the
 * {@link consolidationIndex} — so content can move "balanced" onto granular ground when
 * the questions are all distinct, or onto broad ground when they are siblings. The shift
 * is capped at one neighbour deliberately: the admin's choice stays the primary control,
 * and the ends (`broadest` / `finest`) have no neighbour to move toward, so they hold.
 */
export function targetSlotRange(
  value: DataSlotGranularity,
  questionCount: number,
  profile?: ConsolidationProfile
): { min: number; max: number } {
  const ratio = effectiveRatio(value, profile);
  const min = Math.max(1, Math.round(ratio.min * questionCount));
  const max = Math.min(questionCount, Math.max(min, Math.round(ratio.max * questionCount)));
  return { min, max };
}

/** The level's own ratio band, interpolated toward a neighbour by the profile's index. */
function effectiveRatio(
  value: DataSlotGranularity,
  profile?: ConsolidationProfile
): { min: number; max: number } {
  const level = levelFor(value);
  if (!profile) return level.ratio;

  const index = consolidationIndex(profile);
  if (index === 0) return level.ratio;

  // Levels run broad → fine, so a positive index (more consolidatable) moves toward the
  // PRECEDING entry and a negative one toward the following entry.
  const position = DATA_SLOT_GRANULARITY_LEVELS.indexOf(level);
  const neighbour = DATA_SLOT_GRANULARITY_LEVELS[position + (index > 0 ? -1 : 1)];
  if (!neighbour) return level.ratio; // already at an end — nothing to move toward

  const weight = Math.abs(index);
  return {
    min: level.ratio.min + (neighbour.ratio.min - level.ratio.min) * weight,
    max: level.ratio.max + (neighbour.ratio.max - level.ratio.max) * weight,
  };
}
