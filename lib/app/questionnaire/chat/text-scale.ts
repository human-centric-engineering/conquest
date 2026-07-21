/**
 * Respondent chat text scale — the pure step logic (no React, no DOM).
 *
 * A respondent-owned reading preference: how large the conversation text renders. Kept out of
 * questionnaire config on purpose — an admin cannot know a given respondent's eyesight, screen or
 * viewing distance, so this is the respondent's call on every questionnaire they take, not a
 * per-instrument setting. That is also why the stored key is global rather than session- or
 * version-scoped: someone who needs larger text needs it in every conversation, including the next
 * leg of an Experience, and should set it once.
 *
 * The value is a multiplier applied to the transcript's base size via a CSS custom property, so a
 * step changes one inherited `font-size` and nothing re-layouts beyond reflow. See the
 * `.cq-chat-scale` utility in `app/globals.css` for the rendering half.
 */

/** The multipliers, smallest → largest. `1` is the historical size, so an untouched session is unchanged. */
export const CHAT_TEXT_SCALES = [0.9, 1, 1.15, 1.3] as const;

export type ChatTextScale = (typeof CHAT_TEXT_SCALES)[number];

/** Index of the `1` step — the default, and the fallback for anything unrecognised. */
export const DEFAULT_CHAT_TEXT_SCALE_INDEX = 1;

/** The default multiplier. */
export const DEFAULT_CHAT_TEXT_SCALE: ChatTextScale =
  CHAT_TEXT_SCALES[DEFAULT_CHAT_TEXT_SCALE_INDEX];

/**
 * localStorage key. Deliberately un-namespaced by session or questionnaire — see the module
 * docblock. Versioned (`.v1`) so a future change to the step ladder can ignore stale indices
 * rather than mapping a stale number onto the wrong size.
 */
export const CHAT_TEXT_SCALE_STORAGE_KEY = 'cq-chat-text-scale.v1';

/** Human labels, index-aligned with {@link CHAT_TEXT_SCALES}, for the screen-reader announcement. */
const SCALE_LABELS = ['Small', 'Default', 'Large', 'Largest'] as const;

/**
 * Coerce anything read out of storage into a valid index.
 *
 * Storage is untrusted input: it can hold a stale value from an older ladder, a string, `null`, or
 * whatever another tab wrote. Anything that is not an in-range integer falls back to the default
 * rather than throwing or producing `NaN` in a `calc()` (which would silently kill the font-size).
 */
export function normalizeScaleIndex(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_CHAT_TEXT_SCALE_INDEX;
  if (raw < 0 || raw >= CHAT_TEXT_SCALES.length) return DEFAULT_CHAT_TEXT_SCALE_INDEX;
  return raw;
}

/** The multiplier for an index, normalising first. */
export function scaleForIndex(index: unknown): ChatTextScale {
  return CHAT_TEXT_SCALES[normalizeScaleIndex(index)];
}

/** The label for an index, normalising first. */
export function labelForIndex(index: unknown): string {
  return SCALE_LABELS[normalizeScaleIndex(index)];
}

/**
 * Step one notch. Clamps at both ends rather than wrapping: a respondent pressing the larger
 * control repeatedly must never wrap round to the smallest size, which would read as a bug at
 * exactly the moment someone is struggling to read.
 */
export function stepScaleIndex(index: unknown, direction: 'up' | 'down'): number {
  const current = normalizeScaleIndex(index);
  const next = direction === 'up' ? current + 1 : current - 1;
  return Math.min(CHAT_TEXT_SCALES.length - 1, Math.max(0, next));
}

/** Whether a step in this direction would change anything (drives the disabled state). */
export function canStep(index: unknown, direction: 'up' | 'down'): boolean {
  const current = normalizeScaleIndex(index);
  return stepScaleIndex(current, direction) !== current;
}
