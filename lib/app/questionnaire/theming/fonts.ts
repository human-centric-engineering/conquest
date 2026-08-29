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
  // The escape hatch. Six pairings cover a lot of brands and will never cover a brand that has
  // its own face — so `custom` names two Google families on the client row and we self-host them.
  // Its stack below is the NEUTRAL one, because `custom` with no families set is not an error
  // state to guard against: it is what the row looks like between choosing the option and loading
  // the faces, and the system stack is the right thing to render meanwhile.
  'custom',
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
  // Deliberately the system stack: see the note on the `custom` member above. The real stack is
  // built per client by `customFontStacks`, which needs the families and cannot be a constant.
  custom: {
    display: NEUTRAL_FONT_STACK,
    body: NEUTRAL_FONT_STACK,
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
  custom: {
    label: 'Custom',
    description:
      'Name the client’s own typefaces. We fetch them from Google Fonts once and serve them from here, so the questionnaire is set in the brand’s actual face rather than the nearest one we ship.',
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

/* ── Custom type ───────────────────────────────────────────────────────────── */

/**
 * The weights we fetch and self-host for a custom family.
 *
 * Three, not the whole ramp. Body copy, a medium for emphasis and a bold for the masthead cover
 * every weight the respondent surface actually sets; fetching nine would triple the download and
 * the storage for faces nothing renders. Italics are deliberately absent for the same reason —
 * the surface never sets one.
 */
export const CUSTOM_FONT_WEIGHTS = [400, 600, 700] as const;

export type CustomFontWeight = (typeof CUSTOM_FONT_WEIGHTS)[number];

/** Which of the two slots a custom face fills. */
export const CUSTOM_FONT_SLOTS = ['display', 'body'] as const;

export type CustomFontSlot = (typeof CUSTOM_FONT_SLOTS)[number];

/**
 * What a client actually has stored: slot → weight → the URL we put it at.
 *
 * A partial record at both levels, because a family may not publish every weight and a client may
 * have set only one of the two slots. The render path treats a missing weight as "use what is
 * there"; browsers synthesise the rest, which is far better than refusing to render the face.
 */
export type CustomFontFiles = Partial<
  Record<CustomFontSlot, Partial<Record<`${CustomFontWeight}`, string>>>
>;

/**
 * A Google Fonts family name we are willing to request.
 *
 * Letters, digits, spaces and the few punctuation marks real families use. This is the ONLY thing
 * standing between an admin's text box and a URL we build server-side, so it is an allowlist of
 * the charset rather than a blocklist of the dangerous parts: a family name has no legitimate
 * reason to contain a slash, a colon, an ampersand or a percent, and each of those is a way to
 * reach a different path or smuggle a second query parameter into the request.
 */
const CUSTOM_FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '._-]{0,48}$/;

export function isCustomFontFamily(value: string): boolean {
  return CUSTOM_FONT_FAMILY_PATTERN.test(value.trim());
}

/**
 * Narrow a stored family to one we will render, or null.
 *
 * Forgiving on read exactly as `resolveFontPairing` is: the column is plain text, so a seed, a
 * rollback or a direct write can put anything there, and a questionnaire whose type is unreadable
 * must fall back to the system stack rather than emit an unquotable `font-family`.
 */
export function resolveCustomFontFamily(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && isCustomFontFamily(trimmed) ? trimmed : null;
}

/**
 * The URL-safe id for one stored face, used as the path segment of the serving route.
 *
 * Derived from the family rather than stored, so the route can be addressed without a lookup table
 * — and validated on the way back in, so the segment can only ever name a face we would have
 * written.
 */
export function customFontFaceId(slot: CustomFontSlot, weight: CustomFontWeight): string {
  return `${slot}-${weight}`;
}

/**
 * Build the two `font-family` stacks for a client's custom faces.
 *
 * Each family leads its own stack and falls back to the neutral system stack — the same shape as
 * every shipped pairing, so a face that fails to load degrades identically to one whose webfont is
 * slow. A slot with no family set simply gets the neutral stack, which is why a half-configured
 * custom pairing renders sensibly instead of rendering nothing.
 */
export function customFontStacks(
  display: string | null,
  body: string | null
): { display: string; body: string } {
  const stack = (family: string | null): string =>
    family ? `'${family.replace(/'/g, '')}', ${NEUTRAL_FONT_STACK}` : NEUTRAL_FONT_STACK;

  return { display: stack(display), body: stack(body) };
}
