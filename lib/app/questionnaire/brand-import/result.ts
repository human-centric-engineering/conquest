/**
 * Brand import — the result contract both entry points answer to.
 *
 * A brand import reads a prospect's website (or a screenshot of it) and PROPOSES demo-client theme
 * values. It never persists anything: the admin adjudicates every field and the ordinary save
 * writes them, exactly as the house-rules suggester works.
 *
 * ## Why the shape is this defensive
 *
 * Reading a brand off the open web fails often and in several different ways — a bot wall, an
 * empty SPA shell, a site whose only colours are greys. The feature is therefore designed around
 * its failure modes rather than its happy path:
 *
 *  - **A field we could not read is ABSENT, never a default.** A grey filled into `canvasColor`
 *    because we found nothing better is indistinguishable, on the form, from a grey we measured —
 *    and the admin would ship it. Absence is legible; a plausible wrong value is not.
 *  - **Every unsuccessful outcome names a next step.** `blocked` and `empty` are ordinary answers
 *    here, not errors, so they arrive as a 200 with a reason an admin can act on. A 500 tells the
 *    admin nothing except that we broke.
 *  - **The measured palette always rides along**, even when role assignment failed. Twelve real
 *    colours from the page are useful on their own: the admin can drag one into a field. Throwing
 *    them away because the model was unavailable would discard the expensive half of the work.
 *
 * Pure: no Prisma / Next / sharp. Both the route and the admin dialog import these types, so the
 * shape cannot drift between what the server sends and what the form renders.
 */

/**
 * The demo-client columns an import may propose.
 *
 * Eight colours, three images, one typeface. Two deliberate omissions:
 *
 *  - `canvasColorDark` / `inkColorDark` — `darkenForDarkMode` already derives a dark palette from
 *    the light one (see theming/theme.ts). Proposing a measured dark pair would override a
 *    derivation that is usually better than anything a light-mode page can tell us about a brand's
 *    dark mode.
 *  - `bannerUrl` — the only banner-shaped image a site reliably exposes is `og:image` at roughly
 *    1.9:1, and `BRAND_BANNER_SPEC` requires 4:1 within 12%. Proposing it would guarantee a
 *    rejected upload, so the banner stays a manual choice.
 */
export const IMPORTABLE_FIELDS = [
  'surfaceColor',
  'ctaColor',
  'ctaColorEnd',
  'accentColor',
  'accentColorEnd',
  'canvasColor',
  'inkColor',
  'logoBackgroundColor',
  'logoUrl',
  'logoMarkUrl',
  'logoDarkUrl',
  'fontPairing',
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

/** The colour fields, so a caller can treat hexes and images differently without a string test. */
export const IMPORTABLE_COLOR_FIELDS = [
  'surfaceColor',
  'ctaColor',
  'ctaColorEnd',
  'accentColor',
  'accentColorEnd',
  'canvasColor',
  'inkColor',
  'logoBackgroundColor',
] as const;

export type ImportableColorField = (typeof IMPORTABLE_COLOR_FIELDS)[number];

export function isImportableColorField(field: ImportableField): field is ImportableColorField {
  return (IMPORTABLE_COLOR_FIELDS as readonly string[]).includes(field);
}

/**
 * How much we trust one proposal.
 *
 * Two levels rather than a score, because the admin's decision is binary (accept or don't) and a
 * number invites false precision about a measurement that is fundamentally a heuristic. `high` is
 * "the page said so" — a `theme-color` meta, a `--brand-*` custom property, a logo we found by its
 * schema.org role. `low` is "we inferred it" — a colour ranked by area, a font matched by name.
 */
export type ImportConfidence = 'high' | 'low';

/** One proposed value, with why we believe it. */
export interface ProposedField {
  value: string;
  confidence: ImportConfidence;
  /**
   * Short admin-facing provenance ("from the page's theme-color", "the most-used colour in the
   * logo"). Rendered beside the swatch: an admin deciding whether to accept a colour is really
   * asking where it came from.
   */
  source: string;
  /**
   * Set when the value is usable but carries a caveat — a low-contrast ink/canvas pair, a logo we
   * could only hotlink. Never a blocker, exactly as the form's own contrast warning is not.
   */
  caveat?: string;
}

/** One measured colour and how much of the analysed image it covers (0–1). */
export interface ColorCandidate {
  hex: string;
  share: number;
  /**
   * True for a colour with little chroma — a white, a grey, a near-black, a warm paper stock.
   *
   * Kept rather than discarded, because the neutrals ARE the answer for `canvasColor` and
   * `inkColor`: a page's ground and its text are almost always near-neutral. Discarding low-chroma
   * colours as "not brand colours" is the obvious first implementation and it silently makes the
   * two most structurally important fields unfillable.
   */
  neutral: boolean;
}

/**
 * What happened.
 *
 *  - `ok`      — we read the source and proposed something for most of what we look for.
 *  - `partial` — we read it, but several fields came back empty.
 *  - `blocked` — we never got the bytes (refused, timed out, unsafe target).
 *  - `empty`   — we got the bytes and found nothing brand-like in them.
 */
export type BrandImportOutcome = 'ok' | 'partial' | 'blocked' | 'empty';

/** What the admin should try next. Null when the import went well enough not to need one. */
export type BrandImportNextStep = 'screenshot' | 'manual';

export type BrandImportSource = 'url' | 'screenshot';

export interface BrandImportResult {
  outcome: BrandImportOutcome;
  source: BrandImportSource;
  /** Proposals, keyed by column. A field we could not read is absent — see the module note. */
  fields: Partial<Record<ImportableField, ProposedField>>;
  /** Plain-English explanation for a non-`ok` outcome. Null when `ok`. */
  reason: string | null;
  nextStep: BrandImportNextStep | null;
  /** Everything we measured, ranked by share. Present even on `empty` and on a degraded run. */
  candidates: ColorCandidate[];
  /**
   * True when role assignment was skipped — no LLM provider configured, no vision-capable model in
   * the matrix, or the call failed. The palette is still real; only the mapping from colour to
   * column is missing, and the dialog says so rather than pretending the run was complete.
   */
  degraded: boolean;
}

/** How many proposals we consider a good run. Below this an `ok` run is downgraded to `partial`. */
const OK_FIELD_THRESHOLD = 3;

/**
 * Build the result for a run that reached the analysis stage.
 *
 * Chooses between `ok`, `partial` and `empty` from what actually landed rather than making each
 * call site decide — the outcome must mean the same thing whichever entry point produced it, and
 * three independent ternaries would not stay in step.
 */
export function analysedResult(params: {
  source: BrandImportSource;
  fields: Partial<Record<ImportableField, ProposedField>>;
  candidates: ColorCandidate[];
  degraded: boolean;
  /** Appended to the generated reason — e.g. which budget cap a URL harvest hit. */
  note?: string;
}): BrandImportResult {
  const count = Object.keys(params.fields).length;

  if (count === 0) {
    return {
      outcome: 'empty',
      source: params.source,
      fields: {},
      reason: joinReason(
        params.source === 'url'
          ? 'We read that page but could not find anything that looked like a brand — no logo, no brand colours in its stylesheets.'
          : 'We could not find anything that looked like a brand in that screenshot.',
        params.note
      ),
      nextStep: params.source === 'url' ? 'screenshot' : 'manual',
      candidates: params.candidates,
      degraded: params.degraded,
    };
  }

  if (count < OK_FIELD_THRESHOLD) {
    return {
      outcome: 'partial',
      source: params.source,
      fields: params.fields,
      reason: joinReason(
        `We could only work out ${count === 1 ? 'one field' : `${count} fields`} from that ${
          params.source === 'url' ? 'page' : 'screenshot'
        }. Set the rest by hand, or try the other route.`,
        params.note
      ),
      nextStep: 'manual',
      candidates: params.candidates,
      degraded: params.degraded,
    };
  }

  return {
    outcome: 'ok',
    source: params.source,
    fields: params.fields,
    reason: params.note ?? null,
    nextStep: null,
    candidates: params.candidates,
    degraded: params.degraded,
  };
}

/**
 * Build the result for a run that never got the bytes.
 *
 * Always `nextStep: 'screenshot'`: whatever stopped us server-side (a bot wall, a login, a
 * timeout), the admin's own browser can almost certainly still render the page — which is exactly
 * what the screenshot route is for.
 */
export function blockedResult(params: {
  source: BrandImportSource;
  reason: string;
}): BrandImportResult {
  return {
    outcome: 'blocked',
    source: params.source,
    fields: {},
    reason: params.reason,
    nextStep: 'screenshot',
    candidates: [],
    degraded: false,
  };
}

function joinReason(base: string, note?: string): string {
  return note ? `${base} ${note}` : base;
}
