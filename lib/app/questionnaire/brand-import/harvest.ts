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
  /** Lockup candidates, best guess first — the analyst picks between them by looking at them. */
  logoCandidates: DiscoveredImage[];
  /** The bytes of each fetched candidate, keyed by url. Already downloaded for the palette. */
  logoImages: Map<string, Buffer>;
  /** What the site calls itself — the name a lockup has to match to be this company's. */
  siteName: string | null;
  mark: DiscoveredImage | null;
  /** Dark-lockup candidates. Checked exactly as the light ones are — see verify-logo.ts. */
  logoDarkCandidates: DiscoveredImage[];
  fontFamilies: string[];
  /** Set when the budget cut the harvest short. Surfaces on the result. */
  note: string | null;
}

export type HarvestOutcome = { ok: true; brand: HarvestedBrand } | { ok: false; reason: string };

/** Stylesheets fetched. Two or three carries a design system; a dozen is a crawl. */
const MAX_STYLESHEETS = 3;

/** Images fetched for their pixels — the lockup candidates, the mark, and the dark lockup. */
const MAX_IMAGES = 5;

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

/**
 * Images that match {@link LOGO_HINT} and are somebody ELSE's logo.
 *
 * The single most common way this feature picks the wrong image. A marketing site's homepage is
 * full of files literally named `logo` that belong to press outlets, review sites, integration
 * partners and customers — an "As seen in Forbes" strip is a row of logos, and every one of them
 * beats the company's own on a naive filename match if it happens to appear earlier in the DOM.
 *
 * Two lists because the evidence comes in two forms: a NAME (the outlet itself), and a ROLE (the
 * word "partner" or "award" attached to an otherwise anonymous file). Both are checked against the
 * image's own attributes and against the section it sits in.
 */
const THIRD_PARTY_NAME =
  /\b(?:forbes|techcrunch|bloomberg|reuters|wsj|guardian|telegraph|cnbc|bbc|wired|mashable|venturebeat|g2|capterra|trustpilot|gartner|glassdoor|producthunt|ycombinator|aws|azure|salesforce|shopify|stripe|hubspot|sap|oracle)\b/i;

const THIRD_PARTY_ROLE =
  /\b(?:as[-_ ]?seen|featured[-_ ]?in|as[-_ ]?featured|press|media|award|accredit|certif|badge|partner|integration|client|customer|testimonial|sponsor|member(?:ship)?|review)\b/i;

/**
 * Sections whose images are, by definition, not the site's own logo.
 *
 * Checked on the image's ancestors: a file called `eagle.svg` inside `<section class="our-clients">`
 * is a client's mark however innocent its name looks.
 */
const THIRD_PARTY_CONTAINER =
  /(?:press|media|partner|client|customer|testimonial|award|accredit|sponsor|logo-?(?:wall|strip|cloud|grid|bar)|as-seen|featured-in|trusted-by)/i;

/** How many lockup candidates are kept for verification. Beyond four it is all page furniture. */
const MAX_LOGO_CANDIDATES = 4;

/**
 * A dark-mode lockup, named the way sites actually name them.
 *
 * `white` is anchored the same way `dark` is, and for the same reason the press-badge check exists:
 * an unanchored `white` matched `whitepaper-logo.png` and `logo-whitelabel.svg`, which are ordinary
 * light-mode artwork. The dark slot is where a wrong pick does the most damage — the header band
 * prefers the dark lockup whenever its ground is dark — so a false positive here is worse than a
 * miss.
 */
const DARK_HINT = /(?:^|[-_/])dark|dark[-_.]|inverse|(?:^|[-_/])white(?![a-z])/i;

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
      logoCandidates: images.logoCandidates,
      logoImages: imagePalettes.buffers,
      siteName: readSiteName(doc, base),
      mark: images.mark,
      logoDarkCandidates: images.logoDarkCandidates,
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
  /**
   * Lockup candidates, best guess first.
   *
   * A LIST rather than a single answer, because the ranking is a heuristic over filenames and DOM
   * position and it is wrong often enough to matter — a press badge named `logo.svg` beats the real
   * lockup on every signal this function can see, if it happens to appear first. The candidates go
   * to the analyst, which can actually look at them.
   */
  logoCandidates: DiscoveredImage[];
  mark: DiscoveredImage | null;
  /** Dark-lockup candidates, same shape and same reason as {@link logoCandidates}. */
  logoDarkCandidates: DiscoveredImage[];
}

/**
 * Find the lockup candidates, the square mark and the dark lockup.
 *
 * Candidates are ordered by how much the page is really telling us. A `schema.org` `Organization.logo` is the site
 * asserting "this is our logo"; an `<img>` in the header whose class says `logo` is very nearly
 * that; a filename containing "logo" is a guess that happens to be right most of the time. The
 * favicon is last because it is often a generic square rather than the brand.
 *
 * Images that are plainly somebody ELSE's mark are excluded before ranking — see
 * {@link isThirdPartyLogo}.
 *
 * Exported for its own test: this ordering is the difference between proposing a wordmark and
 * proposing a press badge, and it is easier to get wrong than it looks.
 */
export function discoverImages(doc: Document, base: string): DiscoveredImages {
  const candidates: DiscoveredImage[] = [];
  const seen = new Set<string>();
  for (const found of [
    fromJsonLd(doc, base),
    ...fromHeaderImages(doc, base),
    ...fromFilenames(doc, base),
  ]) {
    if (!found || seen.has(found.url)) continue;
    seen.add(found.url);
    candidates.push(found);
    if (candidates.length >= MAX_LOGO_CANDIDATES) break;
  }

  // apple-touch-icon is typically 180x180 — square by definition and large enough to clear the
  // mark spec's 128px floor, which the 16px favicon never does.
  const mark =
    absolute(
      doc.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href'),
      base,
      'apple-touch-icon'
    ) ?? absolute(doc.querySelector('link[rel~="icon"]')?.getAttribute('href'), base, 'icon');

  return {
    logoCandidates: candidates,
    mark,
    logoDarkCandidates: fromDarkVariants(doc, base).slice(0, MAX_LOGO_CANDIDATES),
  };
}

/**
 * The filename part of a `src`, without its directories or query.
 *
 * The evidence a `src` carries about WHOSE logo this is lives in the file's own name —
 * `forbes-logo.svg` names the outlet. The directories above it are the site's build layout and say
 * nothing about the image, but they are full of words {@link THIRD_PARTY_ROLE} watches for: a
 * Create React App build serves the site's OWN lockup from `/static/media/`, and Django and Wagtail
 * from `/media/`. Both match `\bmedia\b` — `/` is a word boundary — so testing the whole path
 * rejected the real logo on every site built that way, leaving the import with no lockup to propose
 * for a page that plainly has one.
 */
function fileNameOf(src: string | null): string {
  if (!src) return '';
  const path = src.split(/[?#]/)[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * True when an image is plainly somebody else's mark.
 *
 * Reads the image's own attributes AND walks its ancestors, because the two carry different
 * evidence: `forbes-logo.svg` names the outlet, while an anonymous `eagle.svg` inside
 * `<section class="our-clients">` is given away only by where it sits.
 *
 * Exported for its own test — this is the single most common way the import picks the wrong image.
 */
export function isThirdPartyLogo(img: Element): boolean {
  const own = [
    img.getAttribute('class'),
    img.getAttribute('id'),
    img.getAttribute('alt'),
    img.getAttribute('title'),
    fileNameOf(img.getAttribute('src')),
  ].join(' ');
  if (THIRD_PARTY_NAME.test(own) || THIRD_PARTY_ROLE.test(own)) return true;

  // Six levels reaches the section wrapper from an image nested in a card and a link, without
  // reaching <body> on a normal page.
  let node: Element | null = img.parentElement;
  for (let depth = 0; node && depth < 6; depth++) {
    const context = [
      node.getAttribute('class'),
      node.getAttribute('id'),
      node.getAttribute('aria-label'),
    ].join(' ');
    if (THIRD_PARTY_CONTAINER.test(context) || THIRD_PARTY_NAME.test(context)) return true;
    node = node.parentElement;
  }

  return false;
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

function fromHeaderImages(doc: Document, base: string): DiscoveredImage[] {
  const found: DiscoveredImage[] = [];
  const scopes = ['header', 'nav', '[class*="header" i]', '[class*="navbar" i]'];
  for (const scope of scopes) {
    for (const container of Array.from(doc.querySelectorAll(scope))) {
      for (const img of Array.from(container.querySelectorAll('img'))) {
        const signature = `${img.getAttribute('class') ?? ''} ${img.getAttribute('id') ?? ''} ${img.getAttribute('alt') ?? ''} ${img.getAttribute('src') ?? ''}`;
        if (!LOGO_HINT.test(signature)) continue;
        if (isThirdPartyLogo(img)) continue;
        const resolved = absolute(img.getAttribute('src'), base, 'header');
        if (resolved) found.push(resolved);
      }
    }
  }
  return found;
}

function fromFilenames(doc: Document, base: string): DiscoveredImage[] {
  const found: DiscoveredImage[] = [];
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || !LOGO_HINT.test(src)) continue;
    if (isThirdPartyLogo(img)) continue;
    const resolved = absolute(src, base, 'filename');
    if (resolved) found.push(resolved);
  }
  return found;
}

/**
 * A dark lockup, but only when the page says so explicitly.
 *
 * Either a `<picture>` whose `<source>` is scoped to `prefers-color-scheme: dark`, or an image
 * whose name says dark AND says logo. No looser guess: proposing the wrong artwork for the dark
 * lockup is worse than proposing nothing, because the field is one an admin rarely checks.
 */
function fromDarkVariants(doc: Document, base: string): DiscoveredImage[] {
  const found: DiscoveredImage[] = [];

  for (const source of Array.from(doc.querySelectorAll('source[media]'))) {
    const media = source.getAttribute('media') ?? '';
    if (!/prefers-color-scheme\s*:\s*dark/i.test(media)) continue;
    // The `<picture>` this `<source>` belongs to carries the `<img>` whose context tells us whose
    // logo it is — a dark-mode source inside a partner strip is still a partner's.
    const img = source.closest('picture')?.querySelector('img');
    if (img && isThirdPartyLogo(img)) continue;
    const srcset = source.getAttribute('srcset') ?? '';
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first && LOGO_HINT.test(first) && !THIRD_PARTY_NAME.test(first)) {
      const resolved = absolute(first, base, 'dark-variant');
      if (resolved) found.push(resolved);
    }
  }

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!LOGO_HINT.test(src) || !DARK_HINT.test(src)) continue;
    // The exclusion that was missing here is how a "Forbes Communications Council" badge — named
    // like a logo, drawn white for a dark ground — became a client's dark lockup, and then their
    // header band, because the band prefers the dark lockup on a dark ground.
    if (isThirdPartyLogo(img)) continue;
    const resolved = absolute(src, base, 'dark-variant');
    if (resolved) found.push(resolved);
  }

  return found;
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
): Promise<{ logo: ColorCandidate[]; mark: ColorCandidate[]; buffers: Map<string, Buffer> }> {
  const wanted = [...images.logoCandidates, ...images.logoDarkCandidates, images.mark]
    .filter((image): image is DiscoveredImage => image !== null)
    .slice(0, MAX_IMAGES);

  const measured = new Map<string, ColorCandidate[]>();
  const buffers = new Map<string, Buffer>();
  for (const image of wanted) {
    const fetched: FetchOutcome = await fetchResource(image.url, budget, { accept: 'image/*' });
    if (!fetched.ok) {
      logger.info('Brand import: an image was skipped', { url: image.url, reason: fetched.reason });
      continue;
    }
    // sharp rasterises SVG natively, so a vector logo needs no special case to be measured. It
    // does need one to be STORED — see the upload route.
    measured.set(image.url, await extractPalette(fetched.buffer, { max: 6 }));
    buffers.set(image.url, fetched.buffer);
  }

  // The palette is taken from the FIRST candidate only. Mixing several lockups' colours would be
  // worse than taking one: on a page where the ranking is wrong, blending a press badge's palette
  // into the brand's is how a stray red ends up proposed as an accent.
  const primary = images.logoCandidates[0];

  return {
    logo: (primary && measured.get(primary.url)) || [],
    mark: (images.mark && measured.get(images.mark.url)) || [],
    buffers,
  };
}

/**
 * What the site calls itself.
 *
 * The name a candidate lockup has to match to be this company's, so it is what makes "is this
 * actually their logo?" an answerable question rather than a vibe. `og:site_name` is the site
 * stating it outright; a `<title>` is usually "Company — tagline", so only the part before the
 * first separator is kept; the hostname is the last resort and is almost always right in
 * substance if not in spelling.
 */
export function readSiteName(doc: Document, base: string): string | null {
  const og = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim();
  if (og) return og;

  const title = doc.querySelector('title')?.textContent?.trim();
  if (title) {
    const head = title.split(/\s+[|\u2013\u2014\-\u00b7:]\s+/)[0]?.trim();
    if (head) return head;
  }

  try {
    return new URL(base).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
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
