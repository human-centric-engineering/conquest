/**
 * Brand import — read a brand off a live website.
 *
 * Fetch the page, parse it, find the logo, read the stylesheets, and hand back a measured palette
 * plus what the site said about itself. Everything below this — role assignment, contrast,
 * the result contract — is shared with the screenshot path.
 *
 * ## What we look at, and in what order of trust
 *
 * A brand colour discovered three different ways deserves three different levels of confidence,
 * and collapsing them into one list would throw that away:
 *
 *  1. **The logo's own pixels.** A logo IS the brand — this is the strongest signal available, and
 *     the only one that still works when the HTML is an empty SPA shell.
 *  2. **What the page declares.** `<meta name="theme-color">` and a `--brand-primary` custom
 *     property are statements of intent, not accidents.
 *  3. **Colour frequency across the stylesheets.** Real, but mostly greys — a weak signal that
 *     earns its place only because it is sometimes the only one.
 *
 * ## What this cannot do
 *
 * It cannot render. A site whose colours only exist after JavaScript runs, or behind a bot wall,
 * gives up nothing but its HTML shell — which usually still carries a favicon, an `og:image` and a
 * fetchable stylesheet bundle, so the harvest degrades rather than failing. When even that is
 * refused, the answer is the screenshot route: the admin's browser has already rendered the page we
 * cannot.
 *
 * jsdom parses with no `runScripts` and no `resources`, so untrusted remote markup never executes
 * and never fetches anything of its own accord. Every request this module makes is one it chose.
 */

import { JSDOM } from 'jsdom';

import { logger } from '@/lib/logging';

import type { ColorCandidate } from '@/lib/app/questionnaire/brand-import/result';
import { isNeutral, parseHex, toHex } from '@/lib/app/questionnaire/brand-import/color';
import { extractPalette, mergePalettes } from '@/lib/app/questionnaire/brand-import/palette';
import {
  extractColorFrequency,
  extractDeclaredBrandColors,
  parseCssColor,
} from '@/lib/app/questionnaire/brand-import/css-color';
import {
  HarvestBudget,
  fetchResource,
  type FetchOutcome,
} from '@/lib/app/questionnaire/brand-import/fetch';

/** How an image was found. Drives both the confidence we report and the line the admin reads. */
export type ImageProvenance =
  'schema.org' | 'header' | 'filename' | 'apple-touch-icon' | 'icon' | 'dark-variant';

export interface DiscoveredImage {
  url: string;
  via: ImageProvenance;
}

export interface HarvestedBrand {
  /** The merged palette: logo pixels, declared colours and stylesheet frequency, weighted. */
  candidates: ColorCandidate[];
  /** What the page said about itself, passed to the analyst as context. */
  hints: string[];
  /** Hexes the page DECLARED (theme-color, brand custom properties) — these earn high confidence. */
  declared: Set<string>;
  logo: DiscoveredImage | null;
  mark: DiscoveredImage | null;
  logoDark: DiscoveredImage | null;
  fontFamilies: string[];
  /** Set when the budget cut the harvest short. Surfaces on the result. */
  note: string | null;
}

export type HarvestOutcome = { ok: true; brand: HarvestedBrand } | { ok: false; reason: string };

/** Stylesheets fetched. Two or three carries a design system; a dozen is a crawl. */
const MAX_STYLESHEETS = 3;

/** Images fetched for their pixels — the logo, the mark, and one spare. */
const MAX_IMAGES = 3;

/** Stylesheet bytes parsed. A Tailwind bundle can be megabytes; the brand is declared early. */
const MAX_CSS_CHARS = 600_000;

/** Colours taken from CSS frequency. Beyond this it is all border greys. */
const MAX_CSS_CANDIDATES = 8;

/**
 * Relative weights when merging the three sources into one palette.
 *
 * The logo dominates deliberately — see the module note. Declared colours outrank frequency because
 * a name is evidence and a count is not.
 */
const WEIGHT = { logo: 5, mark: 2, declared: 3, frequency: 1 } as const;

/** Attributes and filenames that mark an image as the site's lockup. */
const LOGO_HINT = /logo|wordmark|brand/i;

/** A dark-mode lockup, named the way sites actually name them. */
const DARK_HINT = /(?:^|[-_/])dark|dark[-_.]|inverse|white/i;

export async function harvestSite(
  rawUrl: string,
  budget: HarvestBudget = new HarvestBudget()
): Promise<HarvestOutcome> {
  const url = normaliseUrl(rawUrl);
  if (!url) return { ok: false, reason: 'That does not look like a web address.' };

  const page = await fetchResource(url, budget, {
    accept: 'text/html,application/xhtml+xml',
  });
  if (!page.ok) return { ok: false, reason: page.reason };

  if (page.contentType && !/html|xml/.test(page.contentType)) {
    return {
      ok: false,
      reason: `That address is a ${page.contentType} file, not a web page.`,
    };
  }

  const dom = new JSDOM(page.buffer.toString('utf-8'));
  const doc = dom.window.document;
  const base = page.finalUrl;

  const hints: string[] = [];
  const declared = new Set<string>();

  // 1. What the page declares outright.
  const themeColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')?.trim();
  if (themeColor) {
    const rgb = parseCssColor(themeColor);
    if (rgb) {
      const hex = toHex(rgb);
      declared.add(hex);
      hints.push(`The page declares theme-color: ${hex}`);
    }
  }

  // 2. Images worth looking at.
  const images = discoverImages(doc, base);

  // 3. Stylesheets — inline first (always free), then linked, within budget.
  const css = await collectCss(doc, base, budget);
  const declaredColors = extractDeclaredBrandColors(css);
  for (const entry of declaredColors.slice(0, 6)) {
    declared.add(entry.hex);
    hints.push(`The stylesheet declares ${entry.name}: ${entry.hex}`);
  }

  // 4. Colours from the logo's own pixels — the strongest signal, so it is fetched even when the
  //    stylesheets already gave us something.
  const imagePalettes = await measureImages(images, budget);

  // 5. Inline SVG in the header has no URL to fetch, but its fill/stroke attributes are the same
  //    brand colours the raster logo would have given us.
  const inlineSvgColors = extractInlineSvgColors(doc);

  // `declared` is already ordered by trust — theme-color first, then the brand custom properties in
  // the order the stylesheet named them — and a Set preserves that, so the rank decay in
  // `cssCandidates` lands the right way round without a second sort.
  const candidates = mergePalettes(
    [
      { candidates: imagePalettes.logo, weight: WEIGHT.logo },
      { candidates: inlineSvgColors, weight: WEIGHT.logo },
      { candidates: imagePalettes.mark, weight: WEIGHT.mark },
      { candidates: cssCandidates([...declared]), weight: WEIGHT.declared },
      { candidates: frequencyCandidates(css), weight: WEIGHT.frequency },
    ].filter((source) => source.candidates.length > 0)
  );

  return {
    ok: true,
    brand: {
      candidates,
      hints,
      declared,
      logo: images.logo,
      mark: images.mark,
      logoDark: images.logoDark,
      fontFamilies: discoverFonts(doc, css),
      note: budget.note(),
    },
  };
}

/**
 * Accept what an admin will actually paste.
 *
 * `acme.com` is the common case and is not a URL; requiring the scheme would fail the majority of
 * inputs on a technicality. `http` is upgraded rather than rejected — the site's own redirect will
 * usually take us to https anyway, and the guard re-runs on that hop.
 */
export function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface DiscoveredImages {
  logo: DiscoveredImage | null;
  mark: DiscoveredImage | null;
  logoDark: DiscoveredImage | null;
}

/**
 * Find the lockup, the square mark and the dark lockup.
 *
 * Ordered by how much the page is really telling us. A `schema.org` `Organization.logo` is the site
 * asserting "this is our logo"; an `<img>` in the header whose class says `logo` is very nearly
 * that; a filename containing "logo" is a guess that happens to be right most of the time. The
 * favicon is last because it is often a generic square rather than the brand.
 *
 * Exported for its own test: this ordering is the difference between proposing a wordmark and
 * proposing a 16px favicon, and it is easier to get wrong than it looks.
 */
export function discoverImages(doc: Document, base: string): DiscoveredImages {
  const logo =
    fromJsonLd(doc, base) ?? fromHeaderImage(doc, base) ?? fromFilename(doc, base) ?? null;

  // apple-touch-icon is typically 180x180 — square by definition and large enough to clear the
  // mark spec's 128px floor, which the 16px favicon never does.
  const mark =
    absolute(
      doc.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href'),
      base,
      'apple-touch-icon'
    ) ?? absolute(doc.querySelector('link[rel~="icon"]')?.getAttribute('href'), base, 'icon');

  return { logo, mark, logoDark: fromDarkVariant(doc, base) };
}

function fromJsonLd(doc: Document, base: string): DiscoveredImage | null {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue;
    }
    const logo = findOrganizationLogo(parsed);
    if (logo) {
      const resolved = absolute(logo, base, 'schema.org');
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Walk a JSON-LD blob for an `Organization.logo`.
 *
 * Recursive because the shape varies wildly in the wild: a bare object, an `@graph` array, a
 * `WebSite` whose `publisher` is the Organization. Matching only the top level finds it on perhaps
 * half the sites that actually publish it.
 */
function findOrganizationLogo(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOrganizationLogo(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  const isOrg =
    typeof type === 'string'
      ? /Organization|Corporation|LocalBusiness|Brand/.test(type)
      : Array.isArray(type) &&
        type.some(
          (t) => typeof t === 'string' && /Organization|Corporation|LocalBusiness|Brand/.test(t)
        );

  if (isOrg) {
    const logo = record.logo;
    if (typeof logo === 'string') return logo;
    if (logo && typeof logo === 'object') {
      const url = (logo as Record<string, unknown>).url;
      if (typeof url === 'string') return url;
    }
  }

  for (const value of Object.values(record)) {
    const found = findOrganizationLogo(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function fromHeaderImage(doc: Document, base: string): DiscoveredImage | null {
  const scopes = ['header', 'nav', '[class*="header" i]', '[class*="navbar" i]'];
  for (const scope of scopes) {
    for (const container of Array.from(doc.querySelectorAll(scope))) {
      for (const img of Array.from(container.querySelectorAll('img'))) {
        const signature = `${img.getAttribute('class') ?? ''} ${img.getAttribute('id') ?? ''} ${img.getAttribute('alt') ?? ''} ${img.getAttribute('src') ?? ''}`;
        if (!LOGO_HINT.test(signature)) continue;
        const resolved = absolute(img.getAttribute('src'), base, 'header');
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function fromFilename(doc: Document, base: string): DiscoveredImage | null {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (src && LOGO_HINT.test(src)) {
      const resolved = absolute(src, base, 'filename');
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * A dark lockup, but only when the page says so explicitly.
 *
 * Either a `<picture>` whose `<source>` is scoped to `prefers-color-scheme: dark`, or an image
 * whose name says dark AND says logo. No looser guess: proposing the wrong artwork for the dark
 * lockup is worse than proposing nothing, because the field is one an admin rarely checks.
 */
function fromDarkVariant(doc: Document, base: string): DiscoveredImage | null {
  for (const source of Array.from(doc.querySelectorAll('source[media]'))) {
    const media = source.getAttribute('media') ?? '';
    if (!/prefers-color-scheme\s*:\s*dark/i.test(media)) continue;
    const srcset = source.getAttribute('srcset') ?? '';
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first && LOGO_HINT.test(first)) {
      const resolved = absolute(first, base, 'dark-variant');
      if (resolved) return resolved;
    }
  }

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (LOGO_HINT.test(src) && DARK_HINT.test(src)) {
      const resolved = absolute(src, base, 'dark-variant');
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Resolve a possibly-relative reference against the page, keeping only `https:`.
 *
 * https-only because the stored column is: `isBrandImageSrc` rejects an `http:` URL, so proposing
 * one would offer the admin a value the save would then refuse. Rejecting it here means the field
 * is simply not proposed, which the result contract already handles.
 */
function absolute(
  reference: string | null | undefined,
  base: string,
  via: ImageProvenance
): DiscoveredImage | null {
  if (!reference) return null;
  try {
    const url = new URL(reference, base);
    if (url.protocol !== 'https:') return null;
    return { url: url.toString(), via };
  } catch {
    return null;
  }
}

/** Inline `<style>` plus up to {@link MAX_STYLESHEETS} linked sheets, concatenated and capped. */
async function collectCss(doc: Document, base: string, budget: HarvestBudget): Promise<string> {
  const parts: string[] = [];

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    if (style.textContent) parts.push(style.textContent);
  }

  const hrefs: string[] = [];
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const url = new URL(href, base);
      // Font stylesheets are read for their family names, not their colours — and they are read
      // from the href itself, so fetching them would spend budget for nothing.
      if (url.hostname === 'fonts.googleapis.com') continue;
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      hrefs.push(url.toString());
    } catch {
      continue;
    }
    if (hrefs.length >= MAX_STYLESHEETS) break;
  }

  for (const href of hrefs) {
    const sheet = await fetchResource(href, budget, { accept: 'text/css' });
    if (!sheet.ok) {
      logger.info('Brand import: a stylesheet was skipped', { href, reason: sheet.reason });
      continue;
    }
    parts.push(sheet.buffer.toString('utf-8'));
  }

  // Truncate rather than refuse: a design system declares its brand near the top of the bundle, so
  // the first 600k is where the answer is even when the file is ten times that.
  return parts.join('\n').slice(0, MAX_CSS_CHARS);
}

/** Fetch and measure the discovered images, within budget. */
async function measureImages(
  images: DiscoveredImages,
  budget: HarvestBudget
): Promise<{ logo: ColorCandidate[]; mark: ColorCandidate[] }> {
  const wanted = [images.logo, images.mark, images.logoDark]
    .filter((image): image is DiscoveredImage => image !== null)
    .slice(0, MAX_IMAGES);

  const measured = new Map<string, ColorCandidate[]>();
  for (const image of wanted) {
    const fetched: FetchOutcome = await fetchResource(image.url, budget, { accept: 'image/*' });
    if (!fetched.ok) {
      logger.info('Brand import: an image was skipped', { url: image.url, reason: fetched.reason });
      continue;
    }
    // sharp rasterises SVG natively, so a vector logo needs no special case to be measured. It
    // does need one to be STORED — see the upload route.
    measured.set(image.url, await extractPalette(fetched.buffer, { max: 6 }));
  }

  return {
    logo: (images.logo && measured.get(images.logo.url)) || [],
    mark: (images.mark && measured.get(images.mark.url)) || [],
  };
}

/** Colours found in an inline `<svg>` in the page header — a logo with no file to fetch. */
function extractInlineSvgColors(doc: Document): ColorCandidate[] {
  const hexes: string[] = [];

  for (const scope of ['header', 'nav', '[class*="header" i]']) {
    for (const container of Array.from(doc.querySelectorAll(scope))) {
      for (const svg of Array.from(container.querySelectorAll('svg'))) {
        for (const node of Array.from(svg.querySelectorAll('*'))) {
          for (const attribute of ['fill', 'stop-color', 'stroke']) {
            const value = node.getAttribute(attribute);
            if (!value || value === 'none' || value === 'currentColor') continue;
            const rgb = parseCssColor(value);
            if (rgb) hexes.push(toHex(rgb));
          }
        }
      }
    }
  }

  return cssCandidates(hexes);
}

/** Turn a ranked list of hexes into candidates, sharing weight by position. */
function cssCandidates(hexes: string[]): ColorCandidate[] {
  const unique = [...new Set(hexes)];
  if (unique.length === 0) return [];

  // Linear decay by rank, normalised. The exact curve does not matter — only that a colour named
  // first outranks one named fifth, which is what `mergePalettes` then weighs against the logo.
  const total = (unique.length * (unique.length + 1)) / 2;
  return unique.flatMap((hex, index) => {
    const rgb = parseHex(hex);
    if (!rgb) return [];
    return [{ hex, share: (unique.length - index) / total, neutral: isNeutral(rgb) }];
  });
}

/** Colours by how often the stylesheets mention them. The weakest signal, and usually all greys. */
function frequencyCandidates(css: string): ColorCandidate[] {
  const frequency = extractColorFrequency(css).slice(0, MAX_CSS_CANDIDATES);
  const total = frequency.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return [];

  return frequency.flatMap((entry) => {
    const rgb = parseHex(entry.hex);
    if (!rgb) return [];
    return [{ hex: entry.hex, share: entry.count / total, neutral: isNeutral(rgb) }];
  });
}

/**
 * Font families the page uses, most likely first.
 *
 * Google Fonts links are read ahead of `font-family` declarations because they name what the site
 * deliberately LOADED, where a declaration's stack is mostly fallbacks. Generic keywords are
 * dropped — proposing "sans-serif" as a brand typeface is noise.
 */
export function discoverFonts(doc: Document, css: string): string[] {
  const families: string[] = [];

  for (const link of Array.from(doc.querySelectorAll('link[href*="fonts.googleapis.com"]'))) {
    const href = link.getAttribute('href') ?? '';
    for (const match of href.matchAll(/family=([^&:]+)/g)) {
      families.push(decodeURIComponent(match[1]).replace(/\+/g, ' ').trim());
    }
  }

  for (const match of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = match[1]
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '');
    if (first && !GENERIC_FAMILY.test(first)) families.push(first);
    if (families.length > 20) break;
  }

  return [...new Set(families.filter(Boolean))].slice(0, 8);
}

const GENERIC_FAMILY =
  /^(?:inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|blinkmacsystemfont)$/i;
