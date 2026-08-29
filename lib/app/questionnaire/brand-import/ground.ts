/**
 * Brand import — make the four ground fields a coherent set.
 *
 * A questionnaire is drawn on a ground in TWO modes, and the respondent chooses which. So the
 * import has four fields to answer for, not one: the canvas and its ink in light, and the same
 * pair in dark. This module takes whatever the analyst managed to assign and completes it.
 *
 * ## Why the dark canvas cannot simply be left to the resolver
 *
 * `resolveTheme` derives a dark ground when none is set — but for a canvas that is ALREADY dark it
 * carries the colour across unchanged, on the reasoning that darkening a navy again produces a
 * black rectangle and loses the brand. That is a defensible default for a colour an admin typed,
 * and it is the wrong outcome for an import: a brand whose canvas is a deep purple gets two
 * IDENTICAL panels, and the admin is shown a light/dark comparison in which nothing differs.
 *
 * So the import proposes the dark ground explicitly. The resolver is deliberately left alone —
 * changing it would silently repaint every demo client that already has a dark canvas.
 *
 * ## Why deriving here is not "the model inventing a colour"
 *
 * The measure-then-assign rule says a MODEL may only return colours measured off the page. A
 * derivation is not that: it is arithmetic on a colour the page really used, it is deterministic,
 * and it is labelled as derived where the admin can see it. A site frequently has no dark-mode
 * ground anywhere in its stylesheet — it may not have a dark mode at all — so refusing to derive
 * one would mean the field could never be filled for exactly the brands that need it most.
 *
 * Pure: no Prisma / Next / LLM.
 */

import {
  MIN_CONTRAST_RATIO,
  contrastRatio,
  darkenForDarkMode,
  readableTextColor,
} from '@/lib/app/questionnaire/theming';
import { mix } from '@/lib/app/questionnaire/brand-import/color';
import type { ImportableField, ProposedField } from '@/lib/app/questionnaire/brand-import/result';

/**
 * Below this the two grounds read as the same colour and the mode switch looks broken.
 *
 * A contrast RATIO between the two grounds, not a luminance delta: 1.0 is literally the same
 * colour, and 1.5 is about where a side-by-side comparison stops looking like a rendering bug.
 * Deliberately far below the 4.5 text threshold — these two never appear together, so they need to
 * be *distinguishable*, not legible against each other.
 */
export const MIN_GROUND_SEPARATION = 1.5;

/** How far an already-dark canvas is pushed toward near-black to become its own dark ground. */
const DEEPEN_WEIGHT = 0.55;

/** The ground every derivation heads for — the neutral dark canvas the surface already uses. */
const NEAR_BLACK = '#0a0a0a';

/**
 * A dark-mode ground for a brand canvas that is visibly its own colour.
 *
 * Two cases, because they fail in opposite directions:
 *  - A LIGHT canvas takes the platform's own derivation (the hue as a tint over near-black), which
 *    is already right and which the resolver would have produced anyway.
 *  - An ALREADY-DARK canvas is deepened instead. Tinting it over near-black is what the resolver
 *    declines to do, and rightly — the result is nearly the input. Mixing it toward near-black
 *    keeps the hue while dropping the luminance, so a deep purple becomes a deeper purple rather
 *    than either an unchanged purple or a black rectangle.
 */
export function darkGroundFor(canvas: string): string | null {
  const readable = readableTextColor(canvas);
  if (readable === null) return null;

  // '#ffffff' means the canvas wants light text, i.e. it is already dark.
  return readable === '#ffffff'
    ? mix(canvas, NEAR_BLACK, DEEPEN_WEIGHT)
    : darkenForDarkMode(canvas);
}

/** True when two grounds are far enough apart to read as different modes. */
export function groundsAreDistinct(light: string, dark: string): boolean {
  const ratio = contrastRatio(light, dark);
  return ratio !== null && ratio >= MIN_GROUND_SEPARATION;
}

/**
 * Complete the four ground fields from whatever the analyst assigned.
 *
 * Three rules, in order:
 *
 *  1. **The dark ground must differ from the light one.** The analyst's own choice is kept when it
 *     does; otherwise it is derived (see {@link darkGroundFor}).
 *  2. **An ink that cannot be read is REPLACED, not warned about.** For a value the admin typed the
 *     form warns and saves anyway — a brand may genuinely be low-contrast and refusing would be us
 *     overruling their designer. An imported ink is nobody's decision yet, so shipping an
 *     unreadable pair only sets up a mistake the admin has to catch.
 *  3. **Both inks are filled in.** They resolve to the same values the theme would derive, so this
 *     changes nothing about what renders — it just puts all four fields in front of the admin,
 *     which is the only way the dark pair is reviewable at all.
 *
 * Returns a new bag; the input is not mutated.
 */
export function completeGrounds(
  fields: Partial<Record<ImportableField, ProposedField>>
): Partial<Record<ImportableField, ProposedField>> {
  const out = { ...fields };
  const canvas = out.canvasColor?.value;
  if (!canvas) return out;

  // 1. The dark ground.
  const proposedDark = out.canvasColorDark?.value;
  if (!proposedDark || !groundsAreDistinct(canvas, proposedDark)) {
    const derived = darkGroundFor(canvas);
    // A derivation that lands back on the canvas says nothing — that is what happens when the
    // brand's ground is already at NEAR_BLACK and there is no luminance left to take out of it.
    // Proposing it would put a field in front of the admin whose value repeats the one above it.
    if (derived && derived.toLowerCase() !== canvas.toLowerCase()) {
      out.canvasColorDark = {
        value: derived,
        confidence: 'low',
        source: derivedSource(canvas, derived, proposedDark),
      };
    } else if (proposedDark) {
      delete out.canvasColorDark;
    }
  }

  // 2. Both inks — including replacing one that does not read (rule 1 above). `fillInk` owns that
  // judgement for both modes, so there is one place that decides whether an ink is usable.
  fillInk(out, 'inkColor', canvas);
  const darkCanvas = out.canvasColorDark?.value;
  if (darkCanvas) fillInk(out, 'inkColorDark', darkCanvas);

  return out;
}

/**
 * The line the admin reads under a derived dark ground.
 *
 * Three cases, and the third is why this is a function rather than a ternary. `groundsAreDistinct`
 * gates the analyst's OWN dark ground but is deliberately not applied to the derived one, because
 * for an already-dark brand nothing we could derive would pass it: deepening `#111827` gives
 * `#0d1017`, a ratio of about 1.07 against the light ground, and the only value that would clear
 * 1.5 is a lighter one — the opposite of a dark mode. Dropping the field instead would hand the
 * question back to `resolveTheme`, which carries an already-dark canvas across UNCHANGED, and two
 * identical panels is the exact bug the four-field import was built to fix.
 *
 * So the deepening is kept and the copy stops overclaiming. Saying "dark mode is not the same
 * colour" of a pair the admin can barely tell apart reads as a broken preview; naming it as the
 * subtle change it is explains what they are looking at.
 */
function derivedSource(canvas: string, derived: string, proposedDark: string | undefined): string {
  if (proposedDark) return 'derived — the dark ground we found was too close to the light one';
  return groundsAreDistinct(canvas, derived)
    ? 'derived from the canvas, so dark mode is not the same colour'
    : 'derived — a deeper cut of the canvas, which is as far as an already-dark brand goes';
}

/** Set an ink field from the ground it sits on, unless a readable one is already proposed. */
function fillInk(
  fields: Partial<Record<ImportableField, ProposedField>>,
  field: 'inkColor' | 'inkColorDark',
  ground: string
): void {
  const existing = fields[field]?.value;
  if (existing) {
    const ratio = contrastRatio(ground, existing);
    if (ratio !== null && ratio >= MIN_CONTRAST_RATIO) return;
  }

  const derived = readableTextColor(ground);
  if (!derived) return;

  fields[field] = {
    value: derived,
    confidence: 'low',
    source: existing
      ? 'derived — the text colour we found would not have read on this ground'
      : 'derived for contrast against the ground',
  };
}
