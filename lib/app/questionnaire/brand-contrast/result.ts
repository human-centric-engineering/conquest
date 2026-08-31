/**
 * Contrast optimiser — the contract the route answers and the dialog renders.
 *
 * An admin sets a dozen colours on the branding form and nothing tells them whether a respondent
 * can READ the result. The form already warns about one pair (ink on canvas); every other pair the
 * respondent surface renders — the button label, the band title, the accent used for links — is
 * derived, unwarned, and can still fail. This is the feature that measures all of them and proposes
 * the smallest change that fixes each.
 *
 * ## Why the shape mirrors brand import
 *
 * Deliberately, and not just for consistency. Both features are "we looked at your brand and have
 * suggestions", and both have the same failure mode if built naively: a confident wrong value that
 * the admin ships because it looked authoritative. So both answer with PROPOSALS the admin vetoes
 * field by field, both persist nothing, and both apply through the same ordinary Save.
 *
 * The one thing this adds is a `before`: a contrast proposal is only judgeable next to what it
 * replaces, because the question the admin is really answering is "is this still their brand?".
 *
 * Pure: no Prisma / Next. Both the route and the dialog import these types.
 */

/**
 * The colour columns the optimiser may propose a new value for.
 *
 * A subset of the theme columns, and the subset is the point: these are the ones whose value is
 * measured against something else. `logoBackgroundColor` is absent because what sits on it is an
 * IMAGE, and no ratio we can compute says whether a lockup reads on a backdrop. The image fields
 * and the typeface are absent for the same reason.
 */
export const OPTIMISABLE_FIELDS = [
  'canvasColor',
  'inkColor',
  'canvasColorDark',
  'inkColorDark',
  'ctaColor',
  'ctaColorEnd',
  'surfaceColor',
  'accentColor',
  'accentColorEnd',
] as const;

export type OptimisableField = (typeof OPTIMISABLE_FIELDS)[number];

export function isOptimisableField(value: string): value is OptimisableField {
  return (OPTIMISABLE_FIELDS as readonly string[]).includes(value);
}

/** Which rendered pair a finding is about. Stable ids — the model names one when it chooses. */
export const CONTRAST_PAIRS = [
  'canvas-light',
  'canvas-dark',
  'cta',
  'cta-end',
  'surface',
  'accent-light',
  'accent-dark',
] as const;

export type ContrastPairId = (typeof CONTRAST_PAIRS)[number];

/** One pair that does not read, with the ratio it manages. */
export interface ContrastFinding {
  pair: ContrastPairId;
  /** Admin-facing name of what fails — "Body text on the page" — never a variable name. */
  label: string;
  /** What is drawn on what, as it will actually render (defaults and derivations applied). */
  ground: string;
  ink: string;
  /** The WCAG ratio the pair achieves, and the one it needs. */
  ratio: number;
  target: number;
  /**
   * True when the failing pair involves a colour the admin never set — a derived ink, the neutral
   * default ground. Worth saying: "your ink against the default canvas" is actionable, while "ink
   * on canvas" alone reads as being about a field they cannot find on the form.
   */
  onDerivedValue: boolean;
}

/** One way to fix a finding: move one colour to a shade of itself. */
export interface ContrastRepair {
  field: OptimisableField;
  /** Admin-facing name of the field — the label the branding form uses for it. */
  label: string;
  /**
   * What the field holds on the FORM. Null when it is blank — which is common and meaningful: an
   * unset ink is derived, an unset canvas is our neutral, and the admin needs to be told that the
   * repair fills in a box they have never touched.
   */
  from: string | null;
  /**
   * What actually RENDERS today — `from` when the field is set, otherwise the derived or default
   * value it is standing in for. This is the colour the "before" swatch paints: a blank swatch
   * beside a proposed one would ask the admin to judge a change against nothing.
   */
  current: string;
  /** The proposed shade — same hue and saturation as `from`, or as the value it replaces. */
  to: string;
  /**
   * The pair as it will RENDER once this repair is applied — the ground and the ink, both resolved.
   *
   * Carried rather than left for the caller to work out, because working it out is subtly wrong in
   * two ways. Deriving "which half moved" by comparing the repaired colour to the finding's ink
   * breaks when the ground and the ink are the SAME colour, which is exactly the state the worst
   * finding has (white ink on the default white page). And where the ink is derived from the
   * ground — the button label, the band title — moving the ground can flip the label from dark to
   * light, so the finding's ink is stale the moment the repair is applied.
   */
  resultingGround: string;
  resultingInk: string;
  /** The ratio the pair reaches once this is applied. */
  ratio: number;
  /**
   * How far along the tint/shade ramp the colour moved, and which way: −1 is pure black, 0 is
   * untouched, +1 is pure white.
   *
   * Signed rather than a magnitude, so nothing downstream has to re-derive "did this get lighter or
   * darker" by comparing two hexes. That comparison looks trivial and is not — an early draft
   * compared them as strings and read `#ff0000` as lighter than `#00ff00`.
   */
  amount: number;
}

/** A finding, the ways to fix it, and which one we recommend. */
export interface ContrastProposal {
  finding: ContrastFinding;
  /** Every legal repair, nearest-first. Never empty — a finding with none is dropped instead. */
  repairs: ContrastRepair[];
  /** Index into `repairs`. The model's pick, or the deterministic one when it could not choose. */
  chosen: number;
  /**
   * One plain-English line saying why this repair rather than the others — the actual advice, and
   * the only part of the answer a model writes. Deterministic when there was no model to ask.
   */
  rationale: string;
}

/** What happened. `clean` is a real and common answer, not an empty result. */
export type OptimiseOutcome = 'clean' | 'proposed' | 'unfixable';

export interface OptimiseResult {
  outcome: OptimiseOutcome;
  proposals: ContrastProposal[];
  /**
   * Pairs that fail and that no shade can fix — an accent with no version of itself that clears
   * both grounds, say. Reported rather than hidden: "we cannot fix this automatically" is advice,
   * and silently omitting it would let the admin believe the optimised theme is clean.
   */
  unfixable: ContrastFinding[];
  /**
   * True when the repairs were ranked deterministically because no model was available. The
   * proposals are still real and still correct — only the judgement about WHICH side to move is
   * ours rather than considered, and the dialog says so.
   */
  degraded: boolean;
  /** Plain-English summary, always present. The `clean` case has nothing else to show. */
  summary: string;
}
