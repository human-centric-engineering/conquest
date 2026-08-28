/**
 * Respondent chat text scale — the pure step logic (no React, no DOM).
 *
 * A respondent-owned reading preference: how large the conversation text renders. The respondent
 * always has the last word — an admin cannot know a given person's eyesight, screen or viewing
 * distance, so the stepper is on every questionnaire and there is no switch to remove it. That is
 * also why the stored key is global rather than session- or version-scoped: someone who needs
 * larger text needs it in every conversation, including the next leg of an Experience, and should
 * set it once.
 *
 * What the questionnaire DOES own is where the ladder starts. `config.chatTextSize` names the rung
 * a respondent who has never touched the stepper begins on — a demo on a boardroom screen opens at
 * Largest, a dense instrument opens at Small. It is a STARTING POINT, not a cap: it is passed as
 * the `initial` of the respondent's stored preference, so anyone who has ever stepped keeps their
 * own size and the admin's choice is simply never consulted for them. An admin cannot reach into a
 * respondent's setting, and a respondent cannot be locked out of theirs.
 *
 * The value is a multiplier applied to the transcript's base size via a CSS custom property, so a
 * step changes one inherited `font-size` and nothing re-layouts beyond reflow. See the
 * `.cq-chat-scale` utility in `app/globals.css` for the rendering half.
 */

/** The multipliers, smallest → largest. `1` is the historical size, so an untouched session is unchanged. */
export const CHAT_TEXT_SCALES = [0.9, 1, 1.15, 1.3] as const;

export type ChatTextScale = (typeof CHAT_TEXT_SCALES)[number];

/** Index of the `1` step — the platform default, and the fallback for anything unrecognised. */
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

/**
 * The NAMES for the rungs, index-aligned with {@link CHAT_TEXT_SCALES}.
 *
 * Two things read this. The respondent's screen-reader announcement, which needs a word for the
 * size they just stepped to; and `config.chatTextSize`, which stores an admin's chosen starting
 * rung. The config column stores a NAME rather than an index for the same reason the localStorage
 * key is versioned: the ladder's multipliers can be retuned, and a stored `2` would then quietly
 * mean a different size, where a stored `large` still means the large one.
 *
 * Index alignment with the multipliers is the invariant that makes both work, and it is asserted
 * rather than assumed — see the ladder tests.
 */
export const CHAT_TEXT_SIZES = ['small', 'standard', 'large', 'largest'] as const;

export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];

/**
 * The rung a questionnaire opens on unless its author says otherwise — the same rung
 * {@link DEFAULT_CHAT_TEXT_SCALE_INDEX} points at, so a version with no config row, an older
 * version, and a version whose author left the setting alone all render identically to before.
 */
export const DEFAULT_CHAT_TEXT_SIZE: ChatTextSize = CHAT_TEXT_SIZES[DEFAULT_CHAT_TEXT_SCALE_INDEX];

/** Admin- and respondent-facing copy for each rung, by name. One source, so no surface disagrees. */
export const CHAT_TEXT_SIZE_LABELS: Record<ChatTextSize, string> = {
  small: 'Small',
  standard: 'Standard',
  large: 'Large',
  largest: 'Largest',
};

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
  return CHAT_TEXT_SIZE_LABELS[CHAT_TEXT_SIZES[normalizeScaleIndex(index)]];
}

/**
 * A stored `config.chatTextSize` → the ladder index it names.
 *
 * Forgiving, and for the same reason `resolveFontPairing` and `respondentLayout` are: the column
 * is plain TEXT, so a rollback, a seed, or a newer deploy that knows a rung this build does not
 * can all reach it. An unrecognised name opens at Standard — the size the surface had before this
 * setting existed — rather than failing the render or, worse, producing a `NaN` that would drop
 * the transcript's `font-size` declaration entirely.
 */
export function indexForTextSize(size: string | null | undefined): number {
  // Widened to `readonly string[]` rather than casting the argument INTO the union: the value is
  // a plain column read, and asserting it is already a rung is exactly the lie this function is
  // here to avoid. `indexOf` on the widened tuple answers the question honestly.
  const found = (CHAT_TEXT_SIZES as readonly string[]).indexOf(size ?? '');
  return found === -1 ? DEFAULT_CHAT_TEXT_SCALE_INDEX : found;
}

/** The inverse: a ladder index → its name, normalising anything out of range to the default. */
export function textSizeForIndex(index: unknown): ChatTextSize {
  return CHAT_TEXT_SIZES[normalizeScaleIndex(index)];
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
