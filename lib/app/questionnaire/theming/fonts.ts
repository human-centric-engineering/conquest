/**
 * DEMO-ONLY (brand kit): the type a questionnaire is set in.
 *
 * A colour palette gets a client's brand about half-way; the other half is the type. But
 * asking an admin to name two font families (and then trusting whatever they type to be a
 * face we have actually loaded) is both a worse form and a worse failure mode — a typo is
 * a silent fallback to the system stack. So the choice is a PAIRING: one option, two
 * faces, both already loaded by the root layout.
 *
 * Three pairings, chosen to be recognisably different rather than subtly so — the point of
 * the setting is that a prospect can tell their questionnaire apart from the last one:
 *
 *  - `neutral`      — the system stack. Today's respondent surface, and the default, so a
 *                     client that never touches this renders byte-for-byte as before.
 *  - `editorial`    — Instrument Serif over Newsreader. Broadsheet's natural home: a
 *                     masthead that reads as printed matter.
 *  - `contemporary` — Bricolage Grotesque over Space Grotesk. Confident, slightly
 *                     technical; the pairing Horizon's full-bleed stage was drawn for.
 *
 * The CSS custom-property VALUES live here rather than in brand-theme.css because they are
 * per-client (an inline style on the surface root), not per-surface. What lives in the
 * stylesheet is the neutral default and the two declarations that consume these.
 *
 * Pure: no Prisma / Next / React. `app/layout.tsx` owns the `next/font` loading and must
 * keep its `variable` names in step with {@link FONT_PAIRING_STACKS} — the parity test in
 * tests/unit/lib/app/questionnaire/theming/fonts.test.ts asserts exactly that, because a
 * renamed font variable would degrade silently to the fallback rather than fail a build.
 */

/** The pairings an admin can choose. `neutral` is the default and today's look. */
export const FONT_PAIRINGS = ['neutral', 'editorial', 'contemporary'] as const;

export type FontPairing = (typeof FONT_PAIRINGS)[number];

/** Null / an unrecognised stored value resolves here — the system stack, i.e. no change. */
export const DEFAULT_FONT_PAIRING: FontPairing = 'neutral';

/**
 * The neutral system stack, written once. It is BOTH the `neutral` pairing's two faces and
 * the tail of the other two stacks, so a face that fails to load lands somewhere sane
 * rather than on the browser's default serif.
 */
export const NEUTRAL_FONT_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * Pairing → the two `font-family` values it sets. `display` is headings and the masthead;
 * `body` is running text, including the conversation itself.
 *
 * Each stack leads with the `next/font` variable declared in `app/layout.tsx` and falls
 * back through a widely-available face of the same voice to the neutral stack. The
 * variable is referenced by name rather than imported so this file stays free of Next.
 */
export const FONT_PAIRING_STACKS: Record<FontPairing, { display: string; body: string }> = {
  neutral: {
    display: NEUTRAL_FONT_STACK,
    body: NEUTRAL_FONT_STACK,
  },
  editorial: {
    display: `var(--font-brand-editorial-display), 'Instrument Serif', Georgia, 'Times New Roman', serif`,
    body: `var(--font-brand-editorial-body), Newsreader, Georgia, 'Times New Roman', serif`,
  },
  contemporary: {
    display: `var(--font-brand-contemporary-display), 'Bricolage Grotesque', ${NEUTRAL_FONT_STACK}`,
    body: `var(--font-brand-contemporary-body), 'Space Grotesk', ${NEUTRAL_FONT_STACK}`,
  },
};

/** Admin-facing copy for the pairing picker. One source, so the form and the pack agree. */
export const FONT_PAIRING_COPY: Record<FontPairing, { label: string; description: string }> = {
  neutral: {
    label: 'Neutral',
    description:
      'The system typeface. Gets out of the way — the default, and what every questionnaire uses today.',
  },
  editorial: {
    label: 'Editorial',
    description:
      'A printed-matter serif. Pairs with Broadsheet, and with any brand that reads as considered.',
  },
  contemporary: {
    label: 'Contemporary',
    description:
      'A confident, slightly technical grotesque. Drawn for Horizon, at home on a bold canvas.',
  },
};

/**
 * Narrow a stored value to a pairing, resolving null and anything unrecognised to
 * {@link DEFAULT_FONT_PAIRING}.
 *
 * Forgiving on read by design, and for the same reason `respondentLayout` is: the column is
 * a plain TEXT, so a rollback, a seed, or a newer deploy's value can all reach it. A
 * questionnaire set in an unknown typeface must render in the system stack, not fail.
 */
export function resolveFontPairing(value: string | null | undefined): FontPairing {
  return FONT_PAIRINGS.includes(value as FontPairing)
    ? (value as FontPairing)
    : DEFAULT_FONT_PAIRING;
}
