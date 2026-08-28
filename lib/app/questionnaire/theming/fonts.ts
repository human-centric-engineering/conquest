/**
 * DEMO-ONLY (brand kit): the type a questionnaire is set in.
 *
 * A colour palette gets a client's brand about half-way; the other half is the type. But
 * asking an admin to name two font families (and then trusting whatever they type to be a
 * face we have actually loaded) is both a worse form and a worse failure mode — a typo is
 * a silent fallback to the system stack. So the choice is a PAIRING: one option, two
 * faces, both already loaded by the root layout.
 *
 * Six pairings, chosen to be recognisably different rather than subtly so — the point of
 * the setting is that a prospect can tell their questionnaire apart from the last one. Each
 * occupies a distinct voice, and no two share a face:
 *
 *  - `neutral`      — the system stack. Today's respondent surface, and the default, so a
 *                     client that never touches this renders byte-for-byte as before.
 *  - `editorial`    — Instrument Serif over Newsreader. Broadsheet's natural home: a
 *                     masthead that reads as printed matter.
 *  - `contemporary` — Bricolage Grotesque over Space Grotesk. Confident, slightly
 *                     technical; the pairing Horizon's full-bleed stage was drawn for.
 *  - `humanist`     — Outfit over Source Sans 3. Warm and open where Contemporary is
 *                     engineered; the sans for a brand that wants to sound like a person.
 *  - `classical`    — Playfair Display over Lora. High-contrast and formal — an established
 *                     institution, where Editorial is a newspaper.
 *  - `monospace`    — JetBrains Mono over IBM Plex Mono. Fixed-width throughout: a terminal,
 *                     a typewriter, an engineering brand that means it.
 *
 * ## Why monospace is a whole pairing rather than a "code" toggle
 *
 * A questionnaire set in mono is a legitimate brand voice, not a rendering mode — so it is one
 * more option on the same dial, not a flag beside it. That also keeps the failure mode uniform:
 * every pairing is two faces plus a generic tail, and the mono tail is the only one that ends in
 * `monospace` rather than `serif`/`sans-serif`. Body text in a fixed-width face reads slower, so
 * the admin copy says so — the picker's job is to let a client choose, not to hide the cost.
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

/**
 * The pairings an admin can choose. `neutral` is the default and today's look.
 *
 * Order is the picker's order: the default first, then the rest. Appending is safe — this list is
 * the single source the form, the preview, the settings table and the parity test all read.
 */
export const FONT_PAIRINGS = [
  'neutral',
  'editorial',
  'contemporary',
  'humanist',
  'classical',
  'monospace',
] as const;

export type FontPairing = (typeof FONT_PAIRINGS)[number];

/** Null / an unrecognised stored value resolves here — the system stack, i.e. no change. */
export const DEFAULT_FONT_PAIRING: FontPairing = 'neutral';

/**
 * The neutral system stack, written once. It is BOTH the `neutral` pairing's two faces and
 * the tail of every other PROPORTIONAL stack, so a face that fails to load lands somewhere sane
 * rather than on the browser's default serif. (The `monospace` pairing tails
 * {@link MONO_FONT_STACK} instead — see there for why it does not share this one.)
 */
export const NEUTRAL_FONT_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * The system MONOSPACE stack — what {@link NEUTRAL_FONT_STACK} is for the other five pairings,
 * and the tail of both `monospace` stacks.
 *
 * It exists as its own constant because falling back to `NEUTRAL_FONT_STACK` would be worse than
 * falling back to nothing: a mono questionnaire whose webfont has not arrived yet would reflow
 * from proportional to fixed-width mid-read. Ending in the generic `monospace` keyword means the
 * swap is between two fixed-width faces, which is barely perceptible.
 */
export const MONO_FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

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
  humanist: {
    display: `var(--font-brand-humanist-display), Outfit, 'Avenir Next', ${NEUTRAL_FONT_STACK}`,
    body: `var(--font-brand-humanist-body), 'Source Sans 3', 'Source Sans Pro', ${NEUTRAL_FONT_STACK}`,
  },
  classical: {
    display: `var(--font-brand-classical-display), 'Playfair Display', Georgia, 'Times New Roman', serif`,
    body: `var(--font-brand-classical-body), Lora, Georgia, 'Times New Roman', serif`,
  },
  monospace: {
    display: `var(--font-brand-monospace-display), 'JetBrains Mono', ${MONO_FONT_STACK}`,
    body: `var(--font-brand-monospace-body), 'IBM Plex Mono', ${MONO_FONT_STACK}`,
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
  humanist: {
    label: 'Humanist',
    description:
      'An open, warm sans. Where Contemporary sounds engineered, this sounds like a person — the safest choice after Neutral.',
  },
  classical: {
    label: 'Classical',
    description:
      'A high-contrast display serif over a book face. Formal and established, where Editorial reads as a newspaper.',
  },
  monospace: {
    label: 'Monospace',
    description:
      'Fixed-width throughout — a terminal, a typewriter, an engineering brand. Distinctive, but slower to read in long answers.',
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
