/**
 * DEMO-ONLY (F3.4): the demo-client theming module.
 *
 * A demo client carries four nullable theme columns (ctaColor, accentColor, logoUrl,
 * welcomeCopy). `resolveTheme()` turns that partial, possibly-null brand into a
 * fully-populated {@link ResolvedTheme} by filling each gap with the Sunrise default
 * — so an unthemed (or absent) client renders exactly as the platform always has.
 * `themeToCssVariables()` projects a resolved theme into the CSS custom properties
 * the F7.1 user UI applies; the invitation email (F3.4's renderer) reads the resolved
 * values inline.
 *
 * Pure: no Prisma / Next / React. The DB seam loads the four columns and hands them
 * here; the email and (later) the chat surface consume the resolved result.
 *
 * FORK-GUIDANCE: this whole module is demo tenancy — a real engagement strips it
 * (see .context/app/questionnaire/forking.md § "Replacing demo tenancy"). A fork that
 * keeps branding without the demo marker renames it to a plain theme provider.
 */

/**
 * The raw theme columns as stored on a demo client — every field nullable, where
 * null means "fall back to the Sunrise default". Matches the `AppDemoClient` theme
 * column selection; kept as a hand-written contract so the module stays Prisma-free.
 */
export interface DemoClientTheme {
  /** CTA / primary button colour (hex), or null for the Sunrise default. */
  ctaColor: string | null;
  /** Secondary accent colour (hex), or null for the Sunrise default. */
  accentColor: string | null;
  /** Absolute https logo URL, or null for "no logo". */
  logoUrl: string | null;
  /** Branded invitation intro line, or null for the Sunrise default copy. */
  welcomeCopy: string | null;
}

/**
 * A theme with every colour/copy gap filled. Colours and welcome copy are always
 * present (defaults applied); `logoUrl` stays nullable because there is no default
 * logo — null simply means the renderer shows no logo.
 */
export interface ResolvedTheme {
  ctaColor: string;
  accentColor: string;
  logoUrl: string | null;
  welcomeCopy: string;
}

/**
 * Sunrise defaults — the platform look an unthemed client inherits. `ctaColor` /
 * `accentColor` are the hex the invitation email has always hardcoded (button +
 * link); `welcomeCopy` is the original invitation tagline. There is deliberately no
 * default logo (null → no logo rendered).
 */
export const SUNRISE_THEME_DEFAULTS = {
  ctaColor: '#5469d4',
  accentColor: '#5469d4',
  welcomeCopy:
    "It's a short conversation — answer in your own words and we'll take care of the rest.",
} as const;

/**
 * Fill a (possibly null) demo-client theme with Sunrise defaults. Passing `null`
 * (no attributed client) yields the all-defaults theme, so the generic demo renders
 * identically to the pre-F3.4 plain email.
 */
export function resolveTheme(theme: DemoClientTheme | null): ResolvedTheme {
  return {
    ctaColor: theme?.ctaColor ?? SUNRISE_THEME_DEFAULTS.ctaColor,
    accentColor: theme?.accentColor ?? SUNRISE_THEME_DEFAULTS.accentColor,
    logoUrl: theme?.logoUrl ?? null,
    welcomeCopy: theme?.welcomeCopy ?? SUNRISE_THEME_DEFAULTS.welcomeCopy,
  };
}

/**
 * Project a resolved theme into CSS custom properties for the F7.1 user UI to spread
 * onto a container's `style`. The logo variable is emitted only when a logo is set
 * (an absent `--app-logo-url` lets the UI fall back rather than render `url(null)`).
 *
 * The logo is wrapped as a **quoted** `url("…")` with the URL CSS-escaped: even though
 * `logoUrl` is https-validated at the write boundary, escaping at this sink keeps the
 * value from breaking out of the `url()` (a stray `)` / `;` would otherwise inject an
 * extra declaration into whatever element the UI spreads these vars onto). Defence in
 * depth — the function is exported and the stored value could arrive via a seed or a
 * direct DB write that skips the Zod field.
 */
export function themeToCssVariables(theme: ResolvedTheme): Record<string, string> {
  const vars: Record<string, string> = {
    '--app-cta-color': theme.ctaColor,
    '--app-accent-color': theme.accentColor,
  };
  if (theme.logoUrl) {
    // CSS string escape: backslash-escape `"`, `\`, and newlines, then wrap in quotes
    // so the URL can't terminate the url() context.
    const escaped = theme.logoUrl.replace(/["\\\n\r]/g, '\\$&');
    vars['--app-logo-url'] = `url("${escaped}")`;
  }
  return vars;
}
