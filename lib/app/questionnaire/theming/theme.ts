/**
 * DEMO-ONLY (F3.4): the demo-client theming module.
 *
 * A demo client carries a handful of nullable theme columns (ctaColor, accentColor,
 * logoUrl, welcomeCopy plus the F7.1+ chrome set: surfaceColor, ctaColorEnd,
 * logoBackgroundColor, logoBackgroundEnabled). `resolveTheme()` turns that partial,
 * possibly-null brand into a fully-populated {@link ResolvedTheme} by filling each gap
 * with the ConQuest default — so an unthemed (or absent) client renders as ConQuest
 * rather than as an anonymous grey surface.
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
 * null means "fall back to the ConQuest default". Matches the `AppDemoClient` theme
 * column selection; kept as a hand-written contract so the module stays Prisma-free.
 */
export interface DemoClientTheme {
  /** CTA / primary button colour (hex), or null for the ConQuest default. */
  ctaColor: string | null;
  /** Secondary accent colour (hex), or null for the ConQuest default. */
  accentColor: string | null;
  /** Absolute https logo URL, or null for "no logo". */
  logoUrl: string | null;
  /** Branded invitation intro line, or null for the ConQuest default copy. */
  welcomeCopy: string | null;
  // The F7.1+ chrome columns are OPTIONAL on this raw contract (the original four are
  // required): they landed later, and `resolveTheme` reads them defensively (`?? null` /
  // `?? false`). An absent key therefore resolves identically to an explicit null — so a
  // DB select, a fork, or a test can omit them and still produce a valid theme.
  /**
   * Deep brand "chrome" colour (hex) — the respondent session's header band and the
   * default backdrop the logo sits on. Null/absent = no branded band (plain chrome).
   */
  surfaceColor?: string | null;
  /**
   * CTA gradient *end* colour (hex). When set, the CTA renders as a `ctaColor →
   * ctaColorEnd` gradient (a brand pill); null/absent = a solid `ctaColor`.
   */
  ctaColorEnd?: string | null;
  /**
   * Colour painted behind the logo (hex) when {@link logoBackgroundEnabled}. Null falls
   * back to `surfaceColor` — many logos are drawn for one specific brand backdrop.
   */
  logoBackgroundColor?: string | null;
  /** The admin's "apply this colour as the logo background" toggle. */
  logoBackgroundEnabled?: boolean | null;
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
  /** Brand header-band colour, or null when the client sets no surface (plain chrome). */
  surfaceColor: string | null;
  /** CTA gradient end colour, or null for a solid `ctaColor`. */
  ctaColorEnd: string | null;
  /**
   * The colour to paint behind the logo, or null for "no backdrop". Already resolved:
   * null whenever the backdrop is off; otherwise `logoBackgroundColor` (falling back to
   * `surfaceColor`). Renderers paint this directly without re-deriving the fallback.
   */
  logoBackgroundColor: string | null;
  /**
   * Did the client supply ANY visual brand of its own (a colour, a logo, a surface)?
   *
   * This is the white-label switch. `true` → the client's brand is the only identity in
   * the respondent area, exactly as app/brand-theme.css intends. `false` → there is no
   * client brand to protect, so the renderer falls back to the ConQuest identity: the
   * wordmark in the band and the ConQuest palette on the CTA.
   *
   * `welcomeCopy` is deliberately EXCLUDED from the test — it is copy, not identity, and
   * a client that customises only its invitation line still gets ConQuest chrome.
   */
  hasBrandIdentity: boolean;
}

/**
 * ConQuest defaults — the look an unthemed (or absent) client inherits. `ctaColor` is
 * the deep ConQuest navy and `accentColor` the bright ConQuest blue, matching the
 * consumer palette in app/brand-theme.css; `welcomeCopy` is the original invitation
 * tagline. There is deliberately no default logo (null → the RENDERER substitutes the
 * ConQuest wordmark; see `hasBrandIdentity` below).
 *
 * These are FLAT hexes because their consumers — the invitation email and the export
 * PDFs — have no CSS cascade and no light/dark mode to follow. The live respondent UI
 * does, so it takes the mode-aware route instead (again, see `hasBrandIdentity`).
 */
export const CONQUEST_THEME_DEFAULTS = {
  ctaColor: '#0a1a3a',
  accentColor: '#2f6bff',
  welcomeCopy:
    "It's a short conversation — answer in your own words and we'll take care of the rest.",
} as const;

/**
 * Fill a (possibly null) demo-client theme with ConQuest defaults. Passing `null`
 * (no attributed client) yields the all-defaults theme, so the generic demo renders
 * identically to the pre-F3.4 plain email.
 */
export function resolveTheme(theme: DemoClientTheme | null): ResolvedTheme {
  const surfaceColor = theme?.surfaceColor ?? null;
  // Resolve the logo backdrop once: null whenever the toggle is off, otherwise the
  // explicit logoBackgroundColor falling back to the surface colour. Renderers paint
  // the result directly — they never re-derive the fallback or read the toggle.
  const logoBackgroundColor = theme?.logoBackgroundEnabled
    ? (theme.logoBackgroundColor ?? surfaceColor)
    : null;
  // Any one visual signal is enough to count as "branded" — a client that sets only a
  // logo, or only a CTA colour, still owns the surface. Note this reads the RAW columns,
  // not the resolved ones, so the defaults applied below can't make an unbranded client
  // look branded.
  const hasBrandIdentity = Boolean(
    theme?.ctaColor ||
    theme?.accentColor ||
    theme?.logoUrl ||
    theme?.surfaceColor ||
    theme?.ctaColorEnd ||
    logoBackgroundColor
  );
  return {
    ctaColor: theme?.ctaColor ?? CONQUEST_THEME_DEFAULTS.ctaColor,
    accentColor: theme?.accentColor ?? CONQUEST_THEME_DEFAULTS.accentColor,
    logoUrl: theme?.logoUrl ?? null,
    welcomeCopy: theme?.welcomeCopy ?? CONQUEST_THEME_DEFAULTS.welcomeCopy,
    surfaceColor,
    ctaColorEnd: theme?.ctaColorEnd ?? null,
    logoBackgroundColor,
    hasBrandIdentity,
  };
}

/**
 * The most readable text colour to lay over a solid background — near-white on dark
 * surfaces, near-black on light ones. Picks whichever of white/`#1a1a1a` has the higher
 * WCAG contrast against the surface (relative-luminance based). Returns null when the hex
 * can't be parsed, so the caller omits the variable and the UI falls back to its token.
 *
 * Used to pick `--app-on-surface` for the brand band, whose background is the (arbitrary,
 * possibly dark) client `surfaceColor` — the neutral `text-foreground` token would be
 * near-black and vanish on a dark brand band.
 */
export function readableTextColor(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const c = m[1];
  const full = c.length === 3 ? c.replace(/./g, (ch) => ch + ch) : c;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance =
    0.2126 * linear(channel(0)) + 0.7152 * linear(channel(2)) + 0.0722 * linear(channel(4));
  // Contrast of white vs near-black against this luminance; brighter background → dark text.
  const contrastWhite = 1.05 / (luminance + 0.05);
  const contrastBlack = (luminance + 0.05) / 0.05;
  return contrastWhite >= contrastBlack ? '#ffffff' : '#1a1a1a';
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
  const vars: Record<string, string> = {};
  // UNBRANDED: emit no colour variables at all. An inline style always beats a
  // stylesheet, so emitting the flat ConQuest hexes here would PIN the light-mode
  // palette and break dark mode. Omitting them instead lets the mode-aware
  // `[data-brand='conquest']` block in app/brand-theme.css supply the CTA/accent,
  // flipping navy → gold with the theme exactly as the consumer surface does.
  if (theme.hasBrandIdentity) {
    vars['--app-cta-color'] = theme.ctaColor;
    vars['--app-accent-color'] = theme.accentColor;
    // A single paint value the CTA can drop into `background`: a linear gradient when an
    // end colour is set, otherwise the solid CTA colour. Keeping the branch here means
    // the renderer is just `background: var(--app-cta-gradient)` with no conditionals.
    vars['--app-cta-gradient'] = theme.ctaColorEnd
      ? `linear-gradient(135deg, ${theme.ctaColor}, ${theme.ctaColorEnd})`
      : theme.ctaColor;
  }
  if (theme.surfaceColor) {
    vars['--app-surface-color'] = theme.surfaceColor;
    // The readable text colour for content laid on the band (title / dates), chosen for
    // contrast against the surface so it stays legible on dark and light brand colours alike.
    const onSurface = readableTextColor(theme.surfaceColor);
    if (onSurface) vars['--app-on-surface'] = onSurface;
  }
  if (theme.logoBackgroundColor) {
    vars['--app-logo-bg'] = theme.logoBackgroundColor;
  }
  if (theme.logoUrl) {
    vars['--app-logo-url'] = cssUrl(theme.logoUrl);
  }
  return vars;
}

/**
 * Wrap a URL as a **quoted** CSS `url("…")`, backslash-escaping `"`, `\` and newlines
 * first so the value cannot terminate the `url()` context — a stray `)` or `;` would
 * otherwise inject an extra declaration into whatever element the vars are spread onto.
 *
 * The single sink for brand image URLs entering CSS. Even though the stored value is
 * validated at the write boundary, this escapes again at the point of use: the function
 * is exported and a value can still arrive via a seed or a direct DB write that skips
 * the Zod field. Defence in depth.
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r]/g, '\\$&')}")`;
}
