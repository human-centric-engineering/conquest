/**
 * Fetch a Google Fonts family and store its woff2 files with us.
 *
 * ## Why self-host at all
 *
 * The six shipped pairings work because `next/font` self-hosts them at build time. A per-client
 * face cannot: it is chosen at configuration time, so there is nothing to bundle. The obvious
 * alternative — a `<link>` to fonts.googleapis.com on the respondent surface — does not work here:
 * the CSP's `font-src` is `'self' data:` and `style-src` names no Google origin
 * (`lib/security/headers.ts`), and the only app CSP seam this fork owns is `frame-src`
 * (`lib/app/csp.ts`). Widening the others would mean editing a platform file, which this repo
 * treats as an upstream change, not a local patch.
 *
 * Serving the bytes back from our own origin needs no CSP change at all — and it removes a runtime
 * dependency on Google from every respondent session, which is worth having on its own.
 *
 * ## What we take
 *
 * Three weights, latin only. Body copy, a medium for emphasis and a bold for the masthead cover
 * everything the respondent surface sets; the full ramp would triple the download and the storage
 * for faces nothing renders. A family that does not publish a requested weight simply yields fewer
 * files, and the browser synthesises the rest — far better than refusing the family.
 *
 * The request asks for woff2 by sending a modern browser's `User-Agent`. Google serves a different
 * format per agent, and our own honest agent gets TTF: several times the bytes for the same glyphs,
 * on a file every respondent downloads. This is the one place the import does not announce itself,
 * and it is a format negotiation rather than an attempt to get past a preference.
 */

import { logger } from '@/lib/logging';

import {
  CUSTOM_FONT_WEIGHTS,
  isCustomFontFamily,
  type CustomFontWeight,
} from '@/lib/app/questionnaire/theming';
import { HarvestBudget, fetchResource } from '@/lib/app/questionnaire/brand-import/fetch';

/** Chrome's agent, sent only to fonts.googleapis.com — see the module note on format negotiation. */
const WOFF2_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** One stylesheet plus one file per weight, with room for a redirect. */
const FONT_BUDGET = {
  maxRequests: 8,
  maxResourceBytes: 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024,
  timeoutMs: 15_000,
};

/** `src: url(https://fonts.gstatic.com/…woff2)` inside a `@font-face`, with its weight. */
const FACE_BLOCK = /@font-face\s*\{([^}]*)\}/g;
const FACE_WEIGHT = /font-weight\s*:\s*(\d{3})/;
const FACE_SRC = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/;

export interface FetchedFace {
  weight: CustomFontWeight;
  buffer: Buffer;
}

export type FontFetchOutcome = { ok: true; faces: FetchedFace[] } | { ok: false; reason: string };

/**
 * Fetch the woff2 files for one family.
 *
 * Returns `ok: false` with an admin-facing sentence when the family does not exist — which is also
 * how the family name is VALIDATED. There is no offline catalogue to check against, and shipping
 * one would be a list going stale from the day it was written; asking Google whether the family
 * exists is both the check and the fetch.
 */
export async function fetchGoogleFontFaces(family: string): Promise<FontFetchOutcome> {
  const trimmed = family.trim();
  if (!isCustomFontFamily(trimmed)) {
    return { ok: false, reason: `“${trimmed}” is not a font name we can look up.` };
  }

  const budget = new HarvestBudget(FONT_BUDGET);
  const weights = CUSTOM_FONT_WEIGHTS.join(';');
  // `family` is charset-validated above, so encoding it here cannot smuggle a second parameter.
  const cssUrl =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed).replace(/%20/g, '+')}` +
    `:wght@${weights}&display=swap`;

  const stylesheet = await fetchResource(cssUrl, budget, {
    accept: 'text/css',
    userAgent: WOFF2_USER_AGENT,
  });
  if (!stylesheet.ok) {
    return {
      ok: false,
      reason: `We could not find “${trimmed}” on Google Fonts. Check the spelling — it has to match their name for it exactly.`,
    };
  }

  const wanted = parseFaceUrls(stylesheet.buffer.toString('utf-8'));
  if (wanted.length === 0) {
    return { ok: false, reason: `Google Fonts returned no usable files for “${trimmed}”.` };
  }

  const faces: FetchedFace[] = [];
  for (const face of wanted) {
    const file = await fetchResource(face.url, budget, { accept: 'font/woff2' });
    if (!file.ok) {
      // One missing weight is not a failed family: the browser synthesises what is absent.
      logger.info('Custom font: a weight could not be fetched', {
        family: trimmed,
        weight: face.weight,
        reason: file.reason,
      });
      continue;
    }
    faces.push({ weight: face.weight, buffer: file.buffer });
  }

  if (faces.length === 0) {
    return { ok: false, reason: `We found “${trimmed}” but could not download any of its files.` };
  }

  return { ok: true, faces };
}

/**
 * Pull one woff2 URL per requested weight out of the Google stylesheet.
 *
 * Google emits a `@font-face` per unicode subset — latin, latin-ext, cyrillic, greek and more —
 * all with the same weight. We keep the FIRST for each weight, which is the latin block, because
 * taking them all would multiply the download by six for scripts a demo questionnaire will not set.
 */
export function parseFaceUrls(css: string): { weight: CustomFontWeight; url: string }[] {
  const byWeight = new Map<CustomFontWeight, string>();

  for (const block of css.matchAll(FACE_BLOCK)) {
    const body = block[1];
    const weightMatch = FACE_WEIGHT.exec(body);
    const srcMatch = FACE_SRC.exec(body);
    if (!weightMatch || !srcMatch) continue;

    const weight = Number.parseInt(weightMatch[1], 10) as CustomFontWeight;
    if (!CUSTOM_FONT_WEIGHTS.includes(weight)) continue;
    if (byWeight.has(weight)) continue;

    byWeight.set(weight, srcMatch[1]);
  }

  return [...byWeight.entries()].map(([weight, url]) => ({ weight, url }));
}
