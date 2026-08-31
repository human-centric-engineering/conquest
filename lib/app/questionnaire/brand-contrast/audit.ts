/**
 * Contrast optimiser — measure every pair that renders, and work out how to fix each one.
 *
 * This is the whole feature minus the advice. It reads the RESOLVED theme (defaults filled,
 * derivations applied), measures the pairs a respondent actually sees, and for each failure
 * computes every legal repair — a shade of one of the two colours, hue and saturation untouched.
 *
 * ## Why the arithmetic is not the model's job
 *
 * A language model is bad at "what is the nearest lightness of #2f6bff that clears 4.5:1 against
 * #fffcf5" and confident about its answers, which is the worst combination. It is good at "the
 * paper stock is what this client's site is recognised by — move the ink, not the ground", which is
 * a judgement about a brand and not a calculation.
 *
 * So the split is: this module decides WHAT IS POSSIBLE, and `advise.ts` decides WHICH. The model
 * chooses an index into a list it did not write, exactly as the import analyst can only return a
 * hex it did not measure. A model that is unavailable costs the feature its judgement, not its
 * correctness — `recommendDeterministically` picks the same list's best entry by rule.
 *
 * ## Which pairs, and why these
 *
 * Everything `themeToCssVariables` emits that ends up as one colour drawn on another:
 *
 *  - **the two grounds** — body text on the page, in both modes. The form already warns about
 *    these; the optimiser is the first thing that offers to fix them.
 *  - **the CTA, and its gradient end** — the button label is DERIVED (`readableTextColor`), which
 *    reads as "always fine" and is not: a mid-tone brand colour has no label that clears AA, and
 *    with a gradient the one label has to read across both ends.
 *  - **the band** — same story, same derivation, and it carries the questionnaire title.
 *  - **the accent, on BOTH grounds** — the one that nothing anywhere checks. `--app-accent-color`
 *    is emitted once and rendered in light and dark mode alike, so an accent chosen against a cream
 *    page is also the link colour on the dark one.
 *
 * `logoBackgroundColor` is deliberately absent: what sits on it is an image, and no ratio says
 * whether a lockup reads on a backdrop.
 *
 * Pure: no Prisma / Next / React.
 */

import {
  MIN_CONTRAST_RATIO,
  NEUTRAL_RESPONDENT_GROUND,
  contrastRatio,
  readableTextColor,
  resolveTheme,
  type DemoClientTheme,
  type ResolvedTheme,
} from '@/lib/app/questionnaire/theming';
import {
  nearestReadableShade,
  type ShadeConstraint,
} from '@/lib/app/questionnaire/brand-contrast/shade';
import {
  type ContrastFinding,
  type ContrastPairId,
  type ContrastRepair,
  type OptimisableField,
} from '@/lib/app/questionnaire/brand-contrast/result';

/**
 * Admin-facing field names.
 *
 * Copied from the branding form's own labels rather than invented, for the reason the import dialog
 * copies them too: a proposal has to name the box the admin will see it land in.
 */
/**
 * The threshold for a colour that is not body text.
 *
 * WCAG 1.4.11 (non-text contrast) asks 3:1 of user-interface components and graphical objects,
 * against 1.4.3's 4.5:1 for text. The accent is the one colour here on the non-text side of that
 * line: it drives `--color-primary` — focus rings, borders, button grounds — and not running copy.
 *
 * Holding it to 4.5:1 was the first draft, and it made the feature useless rather than strict:
 * `--app-accent-color` is emitted ONCE and rendered on both grounds, and essentially no saturated
 * colour clears 4.5:1 against a near-white AND a near-black at the same time. Every brand got an
 * "unfixable" it could do nothing about. ConQuest's own accents settle the question — `#2f6bff` on
 * near-black is almost exactly 3:1 — so 4.5 would have been us failing our own palette.
 */
export const MIN_UI_CONTRAST_RATIO = 3;

export const FIELD_LABELS: Record<OptimisableField, string> = {
  canvasColor: 'Canvas colour',
  inkColor: 'Ink colour',
  canvasColorDark: 'Canvas colour (dark mode)',
  inkColorDark: 'Ink colour (dark mode)',
  ctaColor: 'CTA colour',
  ctaColorEnd: 'CTA gradient end',
  surfaceColor: 'Surface colour',
  accentColor: 'Accent colour',
  accentColorEnd: 'Second accent',
};

/**
 * One pair, described in terms of what renders it.
 *
 * `movable` lists the fields a repair may touch, in the order they are OFFERED — not the order
 * they are recommended, which is the judgement `advise.ts` makes. The list is per-pair because it
 * is not symmetric: a CTA's label is derived from the CTA itself, so the only thing that can move
 * is the button colour.
 */
interface MovableColor {
  field: OptimisableField;
  /**
   * Which half of THIS pair the field paints.
   *
   * Recorded rather than inferred from the field name. An earlier draft worked it out from an
   * `ink`-prefix test, which is a coincidence of today's column names and would have silently
   * measured the repaired ratio against the wrong side the first time a column was renamed.
   */
  side: 'ground' | 'ink';
  /** The value being shaded. For an unset field this is the derived value it would replace. */
  current: string;
  /** `from` as the admin sees it: null when the field is blank on the form. */
  authored: string | null;
  /** What a shade of it must read against — more than one when the colour renders twice. */
  constraints: ShadeConstraint[];
}

interface PairSpec {
  id: ContrastPairId;
  label: string;
  ground: string;
  ink: string;
  /** What this pair has to reach — 4.5:1 for text, 3:1 for a UI colour. See the constant above. */
  target: number;
  /**
   * True when the ink is CHOSEN for the ground rather than set — the button label, the band title.
   *
   * Moving such a ground can flip its label from dark to light, so the repaired pair has to be
   * re-derived rather than assumed. Note the constraint fed to the solver still uses the ORIGINAL
   * label, which is safe: `readableTextColor` always returns the better of the two, so satisfying
   * the stale one is a lower bound on the ratio the real one achieves.
   */
  derivesInkFromGround?: boolean;
  /** True when either half of the pair is a default or a derived value rather than an admin's. */
  onDerivedValue: boolean;
  /** For each movable field: the colour it is now, and what the shade has to satisfy. */
  movable: MovableColor[];
}

/**
 * Every pair the respondent surface renders, for this theme.
 *
 * Built from the RESOLVED theme rather than the raw columns, deliberately and for the same reason
 * the form's own warning is: an admin who sets an ink and no canvas gets their ink on the DEFAULT
 * ground, and measuring only authored pairs leaves the one combination guaranteed to be unreadable
 * as the one combination nothing checks.
 */
export function contrastPairs(theme: ResolvedTheme): PairSpec[] {
  const specs: PairSpec[] = [];

  // ── the two grounds ────────────────────────────────────────────────────────
  const lightGround = theme.canvasColor ?? NEUTRAL_RESPONDENT_GROUND.light.canvas;
  const lightInk = theme.onCanvas ?? NEUTRAL_RESPONDENT_GROUND.light.ink;
  const darkGround = theme.canvasColorDark ?? NEUTRAL_RESPONDENT_GROUND.dark.canvas;
  const darkInk = theme.onCanvasDark ?? NEUTRAL_RESPONDENT_GROUND.dark.ink;

  specs.push({
    id: 'canvas-light',
    target: MIN_CONTRAST_RATIO,
    label: 'Body text on the page',
    ground: lightGround,
    ink: lightInk,
    onDerivedValue: theme.canvasColor === null || theme.onCanvas === null,
    movable: [
      {
        field: 'inkColor',
        side: 'ink',
        current: lightInk,
        authored: theme.onCanvas,
        constraints: [{ against: lightGround, min: MIN_CONTRAST_RATIO }],
      },
      {
        field: 'canvasColor',
        side: 'ground',
        current: lightGround,
        authored: theme.canvasColor,
        constraints: [{ against: lightInk, min: MIN_CONTRAST_RATIO }],
      },
    ],
  });

  specs.push({
    id: 'canvas-dark',
    target: MIN_CONTRAST_RATIO,
    label: 'Body text on the page in dark mode',
    ground: darkGround,
    ink: darkInk,
    onDerivedValue: theme.canvasColorDark === null || theme.onCanvasDark === null,
    movable: [
      {
        field: 'inkColorDark',
        side: 'ink',
        current: darkInk,
        authored: theme.onCanvasDark,
        constraints: [{ against: darkGround, min: MIN_CONTRAST_RATIO }],
      },
      {
        field: 'canvasColorDark',
        side: 'ground',
        current: darkGround,
        authored: theme.canvasColorDark,
        constraints: [{ against: darkInk, min: MIN_CONTRAST_RATIO }],
      },
    ],
  });

  // ── the button ─────────────────────────────────────────────────────────────
  // The label is derived from `ctaColor` and shared across the gradient, so the only thing that
  // can move is the button colour itself — and when there IS a gradient, the same label has to
  // read on both ends, which is why each end constrains the other's repair.
  const onCta = readableTextColor(theme.ctaColor);
  if (onCta) {
    specs.push({
      id: 'cta',
      target: MIN_CONTRAST_RATIO,
      derivesInkFromGround: true,
      label: 'The label on the send button',
      ground: theme.ctaColor,
      ink: onCta,
      onDerivedValue: true,
      movable: [
        {
          field: 'ctaColor',
          side: 'ground',
          current: theme.ctaColor,
          authored: theme.ctaColor,
          constraints: [{ against: onCta, min: MIN_CONTRAST_RATIO }],
        },
      ],
    });

    if (theme.ctaColorEnd) {
      specs.push({
        id: 'cta-end',
        target: MIN_CONTRAST_RATIO,
        derivesInkFromGround: true,
        label: 'The label at the far end of the button gradient',
        ground: theme.ctaColorEnd,
        ink: onCta,
        onDerivedValue: true,
        movable: [
          {
            field: 'ctaColorEnd',
            side: 'ground',
            current: theme.ctaColorEnd,
            authored: theme.ctaColorEnd,
            constraints: [{ against: onCta, min: MIN_CONTRAST_RATIO }],
          },
        ],
      });
    }
  }

  // ── the header band ────────────────────────────────────────────────────────
  const onSurface = theme.surfaceColor ? readableTextColor(theme.surfaceColor) : null;
  if (theme.surfaceColor && onSurface) {
    specs.push({
      id: 'surface',
      target: MIN_CONTRAST_RATIO,
      derivesInkFromGround: true,
      label: 'The title on the header band',
      ground: theme.surfaceColor,
      ink: onSurface,
      onDerivedValue: true,
      movable: [
        {
          field: 'surfaceColor',
          side: 'ground',
          current: theme.surfaceColor,
          authored: theme.surfaceColor,
          constraints: [{ against: onSurface, min: MIN_CONTRAST_RATIO }],
        },
      ],
    });
  }

  // ── the accent, on both grounds ────────────────────────────────────────────
  // A single emitted variable rendered in both modes, so any repair must clear BOTH — a shade
  // fixed against the cream page alone is the dark mode's next bug.
  const bothGrounds: ShadeConstraint[] = [
    { against: lightGround, min: MIN_UI_CONTRAST_RATIO },
    { against: darkGround, min: MIN_UI_CONTRAST_RATIO },
  ];
  for (const [id, label, ground] of [
    ['accent-light', 'Links and highlights on the page', lightGround],
    ['accent-dark', 'Links and highlights in dark mode', darkGround],
  ] as const) {
    specs.push({
      id,
      label,
      target: MIN_UI_CONTRAST_RATIO,
      ground,
      ink: theme.accentColor,
      onDerivedValue:
        ground === NEUTRAL_RESPONDENT_GROUND.light.canvas ||
        ground === NEUTRAL_RESPONDENT_GROUND.dark.canvas,
      movable: [
        {
          field: 'accentColor',
          side: 'ink',
          current: theme.accentColor,
          authored: theme.accentColor,
          constraints: bothGrounds,
        },
      ],
    });
  }

  return specs;
}

/** A finding plus every repair for it, or null when the pair reads fine. */
export interface AuditedPair {
  finding: ContrastFinding;
  repairs: ContrastRepair[];
}

/**
 * Measure one pair and, if it fails, solve it.
 *
 * A repair that does not actually raise the ratio is dropped rather than offered: `nearestShade`
 * returns the base colour unchanged when it already satisfies its own constraints, which happens
 * when the OTHER half of the pair is the problem. Offering "change nothing" as a fix would be a
 * proposal that does not fix the thing it names.
 */
function auditPair(spec: PairSpec): AuditedPair | null {
  const ratio = contrastRatio(spec.ground, spec.ink);
  if (ratio === null || ratio >= spec.target) return null;

  const finding: ContrastFinding = {
    pair: spec.id,
    label: spec.label,
    ground: spec.ground,
    ink: spec.ink,
    ratio,
    target: spec.target,
    onDerivedValue: spec.onDerivedValue,
  };

  const repairs: ContrastRepair[] = [];
  for (const option of spec.movable) {
    const shade = nearestReadableShade(option.current, option.constraints);
    // `amount: 0` means the colour already satisfies its OWN constraints, which happens when the
    // other half of the pair is the problem. Offering "change nothing" would be a proposal that
    // does not fix the thing it names.
    if (!shade || shade.amount === 0) continue;

    // Rebuild the pair as it will RENDER, rather than asserting the ratio from the constraint that
    // produced the shade. Where the ink is derived it is re-derived here, so a button whose label
    // flips from dark to light is reported — and previewed — with the label it will actually get.
    const resultingGround = option.side === 'ground' ? shade.hex : spec.ground;
    const resultingInk =
      option.side === 'ink'
        ? shade.hex
        : spec.derivesInkFromGround
          ? (readableTextColor(resultingGround) ?? spec.ink)
          : spec.ink;

    const fixed = contrastRatio(resultingGround, resultingInk);
    if (fixed === null) continue;

    repairs.push({
      field: option.field,
      label: FIELD_LABELS[option.field],
      from: option.authored,
      current: option.current,
      to: shade.hex,
      resultingGround,
      resultingInk,
      ratio: fixed,
      // Signed, so a consumer never has to work out which way the colour moved by comparing two
      // hexes — the comparison that is easy to get wrong and was wrong in the first draft.
      amount: shade.amount,
    });
  }

  // Nearest-first: the least violent change is the one most likely to still be the brand, and it
  // is the default the deterministic fallback takes when there is no model to ask.
  repairs.sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  return { finding, repairs };
}

/**
 * Audit a whole theme.
 *
 * Takes the RAW nullable columns (what the admin's form holds) and resolves them here, so a caller
 * cannot accidentally audit a half-resolved theme — the exact mistake that would make the check
 * measure a pair nobody sees.
 */
export function auditTheme(theme: DemoClientTheme | null): AuditedPair[] {
  const resolved = resolveTheme(theme);
  return contrastPairs(resolved)
    .map(auditPair)
    .filter((audited): audited is AuditedPair => audited !== null);
}
