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

import {
  FONT_PAIRING_STACKS,
  resolveFontPairing,
  type FontPairing,
} from '@/lib/app/questionnaire/theming/fonts';

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
  /** Logo image src (https URL or app-relative upload path), or null for "no logo". */
  logoUrl: string | null;
  /**
   * Full-bleed header banner src (https URL or app-relative upload path), or null.
   * When set it REPLACES the header band's contents — see BrandThemeProvider.
   */
  bannerUrl?: string | null;
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
  // The brand-kit columns are likewise OPTIONAL on the raw contract, and for the same
  // reason: they landed after the chrome set, and every read of them here is defensive.
  // Where the chrome columns above brand what surrounds the conversation, these brand the
  // conversation itself — the ground it is drawn on and the type it is set in.
  /**
   * The page ground (hex) the questionnaire is drawn on — Broadsheet's paper stock,
   * Horizon's field. Null/absent = the neutral respondent canvas, i.e. today's look.
   */
  canvasColor?: string | null;
  /**
   * Text laid on that ground (hex). Null/absent and a canvas is set → derived for contrast
   * from {@link canvasColor}, so an admin who picks a dark canvas never has to work out
   * that they also need light ink.
   */
  inkColor?: string | null;
  /**
   * A SECOND accent (hex) — Horizon's aura, Broadsheet's rule. Deliberately not
   * {@link ctaColorEnd}: that one is the CTA gradient's partner and is consumed only by the
   * button, while this one tints surfaces away from the CTA entirely.
   */
  accentColorEnd?: string | null;
  /** Square mark (~1:1), for a layout that wants a mark rather than the full lockup. */
  logoMarkUrl?: string | null;
  /**
   * The light-on-dark lockup. Needed the moment a ground can be dark: a lockup drawn in the
   * brand's ink disappears on its own dark canvas, and no amount of backdrop fixes that.
   */
  logoDarkUrl?: string | null;
  /** `'editorial' | 'contemporary' | 'neutral'`; null/absent/unknown → the system stack. */
  fontPairing?: string | null;
  /**
   * The same ground in DARK mode. Null/absent → derived from {@link canvasColor} (the brand's
   * colour tinted down over near-black), which is what almost every client wants; set it when
   * the brand specifies its own dark palette.
   *
   * This exists because the respondent can switch modes from any layout, so a canvas that
   * only worked in one of them was never really a setting.
   */
  canvasColorDark?: string | null;
  /** Text on the dark ground (hex). Null/absent → derived for contrast from it. */
  inkColorDark?: string | null;
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
  /** Full-bleed header banner, or null. Takes precedence over `logoUrl` in the band. */
  bannerUrl: string | null;
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
  /** The client's page ground in LIGHT mode, or null for the neutral respondent canvas. */
  canvasColor: string | null;
  /**
   * The colour to lay text in ON that ground — already resolved: the explicit `inkColor`,
   * else derived for contrast against `canvasColor`, else null (the surface keeps its own
   * foreground token). Renderers paint this directly and never re-derive it.
   */
  onCanvas: string | null;
  /**
   * The ground in DARK mode: the explicit `canvasColorDark`, else derived from the light one,
   * else null. A light canvas is tinted down over near-black so the brand's hue survives the
   * switch; a canvas that is ALREADY dark is carried across unchanged rather than darkened
   * twice into a black rectangle.
   */
  canvasColorDark: string | null;
  /** Ink for the dark ground — explicit, else derived for contrast against it, else null. */
  onCanvasDark: string | null;
  /** True when the resolved LIGHT canvas is itself a dark colour (a brand with a dark ground). */
  canvasIsDark: boolean;
  /** The second accent, or null. Surfaces tint with it; the CTA never does. */
  accentColorEnd: string | null;
  /** Square brand mark, or null. */
  logoMarkUrl: string | null;
  /** Light-on-dark lockup, or null. */
  logoDarkUrl: string | null;
  /**
   * The lockup to draw in the header band, already chosen for the ground the band actually
   * paints (its logo backdrop, else the surface colour, else the canvas). A dark ground with
   * a dark lockup available takes it; everything else takes `logoUrl`. Null when there is no
   * logo at all.
   *
   * `logoUrl` above deliberately keeps its old meaning — the default, light-ground lockup —
   * because the invitation email and the export PDFs render onto paper-white and must not
   * follow the band's choice.
   */
  bandLogoUrl: string | null;
  /**
   * The same choice made against the DARK-mode ground. Emitted as its own variable and switched
   * in the stylesheet rather than picked here, because which one applies depends on a mode the
   * server does not know: the respondent can flip it after the page has rendered.
   */
  bandLogoDarkUrl: string | null;
  /** The resolved type pairing; always a real pairing, `'neutral'` when unset or unknown. */
  fontPairing: FontPairing;
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
  const canvasColor = theme?.canvasColor ?? null;
  const logoUrl = theme?.logoUrl ?? null;
  const logoDarkUrl = theme?.logoDarkUrl ?? null;
  // Ink on the ground: the admin's explicit choice wins, otherwise it is derived for
  // contrast — an admin who picks a midnight canvas should not also have to work out that
  // they now need light ink. Null when there is no canvas AND no ink: the surface keeps its
  // own foreground token, exactly as it does today.
  const onCanvas = theme?.inkColor ?? (canvasColor ? readableTextColor(canvasColor) : null);
  // "Dark" means the canvas is one that wants light text on it — the same judgement
  // readableTextColor already makes, reused rather than re-thresholded so the two can never
  // disagree about a borderline mid-tone.
  const canvasIsDark = canvasColor ? isDarkColor(canvasColor) : false;
  // The dark-mode ground. Derived by default because a client should not have to supply a
  // second palette to be allowed a first one — and because the respondent can switch modes
  // whenever they like, so a light-only canvas would simply vanish half the time.
  //
  // A canvas that is already dark is carried across UNCHANGED: darkening a navy again gives a
  // black rectangle and loses the brand entirely, which is the opposite of the point.
  const canvasColorDark =
    theme?.canvasColorDark ??
    (canvasColor ? (canvasIsDark ? canvasColor : darkenForDarkMode(canvasColor)) : null);
  const onCanvasDark =
    theme?.inkColorDark ?? (canvasColorDark ? readableTextColor(canvasColorDark) : null);
  // Which lockup the BAND draws, chosen for the ground the band actually paints: its own
  // logo backdrop if it has one, else the surface colour, else the canvas. Anything else
  // (no ground at all) is the neutral canvas — light in light mode, near-black in dark, which
  // is why the two modes are resolved separately below.
  const lightGround = logoBackgroundColor ?? surfaceColor ?? canvasColor;
  const bandLogoUrl = lightGround && isDarkColor(lightGround) ? (logoDarkUrl ?? logoUrl) : logoUrl;
  // In dark mode the fallback ground is the neutral DARK canvas, so a client with no band
  // colour of their own still gets their light-on-dark lockup if they supplied one.
  const darkGround = logoBackgroundColor ?? surfaceColor ?? canvasColorDark;
  const bandLogoDarkUrl =
    !darkGround || isDarkColor(darkGround) ? (logoDarkUrl ?? logoUrl) : logoUrl;
  // Any one visual signal is enough to count as "branded" — a client that sets only a
  // logo, or only a CTA colour, still owns the surface. Note this reads the RAW columns,
  // not the resolved ones, so the defaults applied below can't make an unbranded client
  // look branded.
  //
  // `fontPairing` is EXCLUDED for the same reason as `welcomeCopy`: it is a design choice
  // rather than an identity. A client who picks the editorial serif and nothing else has
  // handed us no brand to protect, so the questionnaire stays in ConQuest colours — set in
  // that serif.
  const hasBrandIdentity = Boolean(
    theme?.ctaColor ||
    theme?.accentColor ||
    theme?.logoUrl ||
    theme?.bannerUrl ||
    theme?.surfaceColor ||
    theme?.ctaColorEnd ||
    logoBackgroundColor ||
    canvasColor ||
    theme?.canvasColorDark ||
    theme?.inkColor ||
    theme?.inkColorDark ||
    theme?.accentColorEnd ||
    theme?.logoMarkUrl ||
    logoDarkUrl
  );
  return {
    ctaColor: theme?.ctaColor ?? CONQUEST_THEME_DEFAULTS.ctaColor,
    accentColor: theme?.accentColor ?? CONQUEST_THEME_DEFAULTS.accentColor,
    logoUrl,
    bannerUrl: theme?.bannerUrl ?? null,
    welcomeCopy: theme?.welcomeCopy ?? CONQUEST_THEME_DEFAULTS.welcomeCopy,
    surfaceColor,
    ctaColorEnd: theme?.ctaColorEnd ?? null,
    logoBackgroundColor,
    hasBrandIdentity,
    canvasColor,
    onCanvas,
    canvasColorDark,
    onCanvasDark,
    canvasIsDark,
    accentColorEnd: theme?.accentColorEnd ?? null,
    logoMarkUrl: theme?.logoMarkUrl ?? null,
    logoDarkUrl,
    bandLogoUrl,
    bandLogoDarkUrl,
    fontPairing: resolveFontPairing(theme?.fontPairing),
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
  const luminance = relativeLuminance(hex);
  if (luminance === null) return null;
  // Contrast of white vs near-black against this luminance; brighter background → dark text.
  const contrastWhite = 1.05 / (luminance + 0.05);
  const contrastBlack = (luminance + 0.05) / 0.05;
  return contrastWhite >= contrastBlack ? '#ffffff' : '#1a1a1a';
}

/**
 * True when a colour wants light text on it.
 *
 * Delegates to {@link readableTextColor} rather than thresholding luminance again, so the ink a
 * surface renders and the judgement that picks its lockup can never disagree about a borderline
 * mid-tone. Unparseable → false, i.e. treated as light, which is the safer default: the standard
 * lockup on an unknown ground beats a light-on-dark one on white.
 */
function isDarkColor(hex: string): boolean {
  return readableTextColor(hex) === '#ffffff';
}

/**
 * A dark-mode counterpart for a light brand canvas: the client's colour at 14% over near-black.
 *
 * Dark mode is not "the same page, inverted" — it is a different ground, and a cream paper stock
 * has no honest inversion. What it does have is a HUE, and keeping that hue as a tint over the
 * near-black the respondent surface already uses is what makes a dark-mode Broadsheet still look
 * like the client's rather than like everyone else's. 14% is enough to read as a tint at a glance
 * and low enough that white text stays comfortably past AA on every hue.
 *
 * Returns the input unchanged when it cannot be parsed — the write boundary validates hex, and a
 * value that arrived some other way is better rendered as-is than replaced with black.
 */
export function darkenForDarkMode(hex: string): string {
  return mixToward(hex, DARK_MODE_GROUND, 0.14) ?? hex;
}

/** The near-black the respondent surface uses when no client canvas is set. */
const DARK_MODE_GROUND = '#0a0a0a';

/**
 * Mix `hex` into `base` at `weight` (0–1 of the source colour), in sRGB, returning `#rrggbb`.
 * Null when either colour can't be parsed.
 *
 * Done in TypeScript rather than as a CSS `color-mix()` because the RESULT is needed as a real
 * colour: `readableTextColor` has to read it to derive the dark ink, and it cannot see inside a
 * `color-mix()` the browser has not computed yet.
 */
function mixToward(hex: string, base: string, weight: number): string | null {
  const a = channels(hex);
  const b = channels(base);
  if (!a || !b) return null;
  const mixed = a.map((v, i) => Math.round(v * weight + b[i] * (1 - weight)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** `[r, g, b]` 0–255 from a `#rgb` / `#rrggbb` colour, or null. */
function channels(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const c = m[1];
  const full = c.length === 3 ? c.replace(/./g, (ch) => ch + ch) : c;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * WCAG relative luminance of a `#rgb` / `#rrggbb` colour, or null when it can't be parsed.
 *
 * Extracted so {@link readableTextColor} and {@link contrastRatio} cannot disagree about a
 * borderline mid-tone — the picker warning an admin sees and the ink the surface actually
 * renders are then two readings of one number, not two implementations of one formula.
 */
function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const c = m[1];
  const full = c.length === 3 ? c.replace(/./g, (ch) => ch + ch) : c;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channel(0)) + 0.7152 * linear(channel(2)) + 0.0722 * linear(channel(4));
}

/**
 * WCAG contrast ratio between two hex colours (1–21), or null when either can't be parsed.
 *
 * The admin picks a canvas and an ink independently, and nothing stops the pair being
 * unreadable — a mid-grey ink on a mid-grey paper stock passes every hex validator we have.
 * The form uses this for a SOFT warning: a brand may genuinely be low-contrast, and refusing
 * to save it would be us overruling the client's designer, so it says the number and lets the
 * admin decide.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG AA for body text. Below this the demo-client form warns (it never blocks). */
export const MIN_CONTRAST_RATIO = 4.5;

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
    // The CTA's own foreground, chosen for contrast against the client's CTA colour. The
    // buttons paint their background from `--app-cta-gradient` directly and so never
    // consult the platform's `primary`/`primary-foreground` pair — without this a client
    // who picks a pale CTA gets white-on-pale. Unbranded clients are covered by the
    // `[data-brand='conquest']` block in app/brand-theme.css instead, which is mode-aware.
    const onCta = readableTextColor(theme.ctaColor);
    if (onCta) vars['--app-on-cta'] = onCta;
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
  // The BAND's lockup, already chosen for the ground the band paints (see `bandLogoUrl`) — but
  // emitted once PER MODE, because which ground applies depends on a switch the respondent can
  // flip after the page has rendered. `app/brand-theme.css` picks between these two and publishes
  // the winner as `--app-logo-url`, so the band renderer still reads one variable and has no
  // branch of its own.
  if (theme.bandLogoUrl) {
    vars['--app-logo-src'] = cssUrl(theme.bandLogoUrl);
  }
  if (theme.bandLogoDarkUrl) {
    vars['--app-logo-src-dark'] = cssUrl(theme.bandLogoDarkUrl);
  }
  if (theme.bannerUrl) {
    vars['--app-banner-url'] = cssUrl(theme.bannerUrl);
  }
  if (theme.logoMarkUrl) {
    vars['--app-logo-mark-url'] = cssUrl(theme.logoMarkUrl);
  }
  // The GROUND, in both modes. Emitted whenever either half is set — a client may want their ink
  // on the neutral canvas, or a canvas with derived ink, and both are coherent.
  //
  // Four variables rather than two, and none of them called `--app-canvas-color`: the stylesheet
  // publishes THAT one, choosing per mode from these. A single value could not work — the
  // respondent switches modes client-side, long after the server resolved the theme, and CSS
  // cannot pick between two values a custom property does not hold.
  if (theme.canvasColor) {
    vars['--app-canvas-light'] = theme.canvasColor;
  }
  if (theme.onCanvas) {
    vars['--app-ink-light'] = theme.onCanvas;
  }
  if (theme.canvasColorDark) {
    vars['--app-canvas-dark'] = theme.canvasColorDark;
  }
  if (theme.onCanvasDark) {
    vars['--app-ink-dark'] = theme.onCanvasDark;
  }
  // The second accent, and the wash a layout tints large areas with. The aura is emitted as
  // a `color-mix` rather than a pre-computed hex so it stays honest over whatever the accent
  // sits on — the alpha is the point, and flattening it here would bake in a background.
  if (theme.accentColorEnd) {
    vars['--app-accent-end'] = theme.accentColorEnd;
    vars['--app-accent-aura'] =
      `linear-gradient(135deg, color-mix(in srgb, ${theme.accentColor} 22%, transparent), color-mix(in srgb, ${theme.accentColorEnd} 22%, transparent))`;
  }
  // Type. Emitted only for a non-neutral pairing: `neutral` IS the stylesheet's default, and
  // an inline style always beats a stylesheet, so writing it here would pin the system stack
  // onto portalled roots that might later want their own.
  if (theme.fontPairing !== 'neutral') {
    const stacks = FONT_PAIRING_STACKS[theme.fontPairing];
    vars['--app-font-display'] = stacks.display;
    vars['--app-font-body'] = stacks.body;
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
