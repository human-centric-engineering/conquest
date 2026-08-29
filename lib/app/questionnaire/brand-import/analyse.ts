/**
 * Brand import — the entry point.
 *
 * Measure a palette, ask the analyst which colour plays which role, annotate the pair that has to
 * read against itself, and return the shared result contract. A URL adds a harvest in front of that
 * and proposes images and a typeface as well; everything below the harvest is shared.
 *
 * ## Why an address and a picture are one call, not two routes
 *
 * We cannot render a website server-side — Playwright is a dev dependency and Chromium on a
 * serverless function is a size-and-cold-start fight we would lose — while the admin's own browser
 * has already rendered the page perfectly. That started as a fallback for a blocked fetch, and the
 * two sources turned out to be complementary rather than alternative:
 *
 * | Source       | Sees                                                                      |
 * | ------------ | ------------------------------------------------------------------------- |
 * | The site     | The logo file, the typeface, `--brand-primary` — things only markup names. |
 * | A screenshot | Painted AREA on the rendered page — the ground, the ink, what is really big. |
 *
 * A stylesheet cannot tell us which of its ninety colours the page is actually drawn in: our count
 * of `#f8f2ec` in a CSS file is a count of tokens, not of pixels. The screenshot answers exactly
 * that and nothing else. So both go into one merged palette and one analyst call — and either one
 * on its own still works, which is what an admin with only an address, or only a picture, has.
 *
 * A blocked harvest is therefore no longer the end of the run: with screenshots in hand we analyse
 * those and say the site itself could not be read, rather than returning nothing.
 */

import { logger } from '@/lib/logging';

import {
  analysedResult,
  blockedResult,
  type BrandImportResult,
  type BrandImportSource,
  type ColorCandidate,
  type ImportableField,
  type ProposedField,
} from '@/lib/app/questionnaire/brand-import/result';
import { extractPalette, mergePalettes } from '@/lib/app/questionnaire/brand-import/palette';
import {
  assignRoles,
  type RoleAssignment,
} from '@/lib/app/questionnaire/brand-import/assign-roles';
import { annotateContrast } from '@/lib/app/questionnaire/brand-import/contrast';
import { completeGrounds } from '@/lib/app/questionnaire/brand-import/ground';
import {
  harvestSite,
  type DiscoveredImage,
  type HarvestedBrand,
} from '@/lib/app/questionnaire/brand-import/harvest';
import { verifyLogo } from '@/lib/app/questionnaire/brand-import/verify-logo';
import { matchFontPairing } from '@/lib/app/questionnaire/brand-import/font-match';

/**
 * Relative weight of the two evidence sources when both are present.
 *
 * The screenshot leads because it is the only source that measures the rendered page: it is what
 * settles the ground and the ink, which a stylesheet's token counts cannot. The site is not far
 * behind, because a brand's accent may occupy a few dozen pixels of one frame and still be the
 * colour the company is known by — the logo's palette keeps it in the list.
 */
const SOURCE_WEIGHT = { site: 2, screenshot: 3 } as const;

/** One screenshot as it reaches analysis: bytes plus the type we DETECTED in them. */
export interface ScreenshotImage {
  buffer: Buffer;
  /** The type the magic-byte check DETECTED, never the one the browser claimed. */
  mediaType: string;
}

export interface BrandImportInput {
  /** The client's website. Absent when the admin has only a picture. */
  url?: string;
  /** Screenshots of it. Empty when the admin has only an address. */
  screenshots?: ScreenshotImage[];
  /** The client this import is for, when the form has one. Threaded through for cost attribution. */
  demoClientId?: string;
}

/**
 * Analyse a website, a set of screenshots, or both, into proposed theme fields.
 *
 * Never throws for an ordinary failure. A bot wall, an undecodable image, an unseeded agent and an
 * unreachable provider all resolve to a result the dialog can render — `blocked` or `empty` with a
 * next step, or the measured palette marked `degraded`. The only thing that reaches the route as an
 * exception is a genuine defect.
 *
 * The caller guarantees at least one source; with neither, the honest answer is `empty` and that is
 * what falls out of measuring nothing.
 */
export async function analyseBrand(input: BrandImportInput): Promise<BrandImportResult> {
  const screenshots = input.screenshots ?? [];
  const harvested = input.url ? await harvestSite(input.url) : null;

  // An address we could not read AND no picture is the one case with nothing left to say. With
  // screenshots in hand we carry on: they are a complete answer for colour, just not for the logo.
  if (harvested && !harvested.ok && screenshots.length === 0) {
    return blockedResult({ source: 'url', reason: harvested.reason });
  }

  const brand = harvested?.ok ? harvested.brand : null;

  const fields: Partial<Record<ImportableField, ProposedField>> = {};
  let logoNote: string | null = null;

  if (brand) {
    // The lockup is CHECKED, not just ranked: every signal the harvest can see is circumstantial,
    // and a press badge named `logo.svg` satisfies all of them. See verify-logo.ts.
    const logo = await chooseLogo(brand, input.demoClientId);
    logoNote = logo.note;
    // Images and type are found by parsing, not by measuring, so they are worth proposing even
    // when the page gave up no usable colours at all — a logo alone is a real result.
    Object.assign(fields, logo.field, imageFields(brand.mark), fontField(brand.fontFamilies));
  }

  // Screenshots are merged with each other first, so that a set of five frames still weighs the
  // same against the site as a single frame does — otherwise "upload more pictures" would quietly
  // become "outvote the logo".
  const shotPalettes = await Promise.all(screenshots.map((shot) => extractPalette(shot.buffer)));
  const screenshotCandidates = mergePalettes(
    shotPalettes
      .filter((palette) => palette.length > 0)
      .map((candidates) => ({
        candidates,
        weight: 1,
      }))
  );

  const candidates = mergePalettes(
    [
      { candidates: brand?.candidates ?? [], weight: SOURCE_WEIGHT.site },
      { candidates: screenshotCandidates, weight: SOURCE_WEIGHT.screenshot },
    ].filter((source) => source.candidates.length > 0)
  );

  let degraded = false;
  if (candidates.length > 0) {
    try {
      const assigned = await assignRoles({
        candidates,
        demoClientId: input.demoClientId,
        hints: brand?.hints,
        images: screenshots.map((shot) => ({
          base64: shot.buffer.toString('base64'),
          mediaType: shot.mediaType,
        })),
      });
      Object.assign(
        fields,
        colourFields(assigned.assignments, {
          declared: brand?.declared ?? new Set<string>(),
          measured: new Set(screenshotCandidates.map((candidate) => candidate.hex)),
          sawImages: assigned.sawImages,
        })
      );
    } catch (error) {
      // Expected in a deployment with no provider configured, and after a provider outage. The
      // palette is the expensive part and it is already in hand, so this degrades rather than fails.
      degraded = true;
      logger.info('Brand import: role assignment unavailable, returning the measured palette', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return analysedResult({
    source: sourceOf(Boolean(brand), screenshots.length > 0),
    // `completeGrounds` before `annotateContrast`: it drops an unreadable ink and fills the dark
    // pair, so by the time the contrast annotation runs there is nothing left for it to warn about
    // unless the admin's own later edits create it.
    fields: annotateContrast(completeGrounds(fields)),
    candidates,
    degraded,
    note: joinNotes(
      harvested && !harvested.ok
        ? `We could not read that website — ${lowerFirst(harvested.reason)} ${
            screenshots.length === 1 ? 'The screenshot was' : 'The screenshots were'
          } used on their own, so there is no logo or typeface in what follows.`
        : (brand?.note ?? null),
      logoNote,
      degraded
        ? 'We measured the colours but could not work out which is which — no AI provider was available. Pick from the palette below.'
        : null
    ),
  });
}

/**
 * Which sources actually produced the answer.
 *
 * A URL that came back blocked is NOT reported as a source: the result the admin is reading was
 * measured from their screenshots alone, and saying otherwise would attribute it to a page we
 * never read.
 */
function sourceOf(hasSite: boolean, hasScreenshots: boolean): BrandImportSource {
  if (hasSite && hasScreenshots) return 'combined';
  return hasScreenshots ? 'screenshot' : 'url';
}

/** A harvest reason reads as its own sentence; inside one it needs its capital dropped. */
function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** Re-exported so the route can render a palette-only answer without reaching past this module. */
export type { ColorCandidate };

/**
 * Turn colour assignments into proposals, splitting confidence by how we came to know the colour.
 *
 * Three kinds of evidence, and they are not equal:
 *
 *  - **The site DECLARED it** — as `theme-color`, or as a `--brand-primary` custom property. That
 *    is the company asserting its own brand, and it is reported as high confidence with the reason
 *    attached.
 *  - **We MEASURED it in a screenshot** the admin took of the rendered page. Also high, when a
 *    vision model actually read the picture: painted area is the strongest evidence there is for
 *    what a page's ground and ink really are.
 *  - **Neither** — it was ranked out of logo pixels and stylesheet token counts by a model that
 *    could not see the page. That is a genuine guess, and it is labelled one.
 *
 * A colour that is both declared and measured is the strongest result this feature produces: two
 * independent sources agreeing is the whole reason an admin can give us an address AND a picture.
 * Flattening these would tell them that a border grey we happened to rank third is as certain as
 * the colour the site named and the screenshot showed.
 */
function colourFields(
  assignments: RoleAssignment[],
  evidence: { declared: Set<string>; measured: Set<string>; sawImages: boolean }
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};
  for (const assignment of assignments) {
    const declared = evidence.declared.has(assignment.hex);
    const measured = evidence.measured.has(assignment.hex);

    fields[assignment.field] = {
      value: assignment.hex,
      confidence: declared || (measured && evidence.sawImages) ? 'high' : 'low',
      source: provenanceCopy(declared, measured, evidence.sawImages),
    };
  }
  return fields;
}

function provenanceCopy(declared: boolean, measured: boolean, sawImages: boolean): string {
  if (declared && measured) {
    return 'the site declares this colour as part of its brand, and we measured it in your screenshot';
  }
  if (declared) return 'the site declares this colour as part of its brand';
  if (measured) {
    return sawImages
      ? 'measured from your screenshot'
      : 'inferred from your screenshot’s palette (no image model available)';
  }
  return 'measured from the site’s logo and stylesheets';
}

/** Admin-facing provenance for each way an image was found, in the same order as the trust ladder. */
const IMAGE_SOURCE_COPY: Record<DiscoveredImage['via'], string> = {
  'schema.org': 'the site publishes this as its organisation logo',
  header: 'found in the site’s header',
  filename: 'an image on the page named like a logo',
  'apple-touch-icon': 'the site’s touch icon (square)',
  icon: 'the site’s favicon',
  'dark-variant': 'the site’s dark-mode lockup',
};

/**
 * `schema.org` and an explicit dark `<source>` are the site telling us what these images are;
 * everything else is a well-founded guess about an image that might be a hero shot.
 */
const HIGH_CONFIDENCE_PROVENANCE = new Set<DiscoveredImage['via']>(['schema.org', 'dark-variant']);

function imageFields(
  mark: DiscoveredImage | null
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};

  for (const [field, image] of [['logoMarkUrl', mark]] as const) {
    if (!image) continue;
    fields[field] = {
      value: image.url,
      confidence: HIGH_CONFIDENCE_PROVENANCE.has(image.via) ? 'high' : 'low',
      source: IMAGE_SOURCE_COPY[image.via],
    };
  }

  return fields;
}

/**
 * Propose a typeface.
 *
 * Two very different outcomes. An **exact** match means the site uses one of the ten faces we
 * already ship, so the pairing reproduces the brand and nothing needs fetching. Anything else means
 * the brand has its own face — and rounding it to "the closest grotesque we happen to load" is
 * exactly the approximation the custom option exists to avoid. So a shape match proposes `custom`
 * plus the families themselves, which accepting will fetch and self-host.
 *
 * The caveat is not decoration: the families are names read off a page, not entries checked against
 * a catalogue (there is no offline catalogue to check, and shipping one would go stale immediately).
 * Whether they exist on Google Fonts is only settled by trying, so the admin is told that up front
 * rather than discovering it when apply fails.
 */
function fontField(families: string[]): Partial<Record<ImportableField, ProposedField>> {
  const match = matchFontPairing(families);
  if (!match) return {};

  if (match.how === 'exact') {
    return {
      fontPairing: {
        value: match.pairing,
        confidence: 'high',
        source: `the site sets type in ${match.family}, which is one of our pairings`,
      },
    };
  }

  // Headings and body, when the page named two faces. A site that names only one sets both from
  // it, which is what a single-typeface brand actually does.
  const display = families[0];
  const body = families[1] ?? families[0];

  return {
    fontPairing: {
      value: 'custom',
      confidence: 'low',
      source: `the site sets type in ${match.family}, which is not one of our pairings`,
      caveat: `We will try to load ${display}${body !== display ? ` and ${body}` : ''} from Google Fonts. If they are not there, pick a pairing by hand instead.`,
    },
    customFontDisplay: {
      value: display,
      confidence: 'low',
      source: 'the headings typeface named on the site',
    },
    customFontBody: {
      value: body,
      confidence: 'low',
      source: 'the body typeface named on the site',
    },
  };
}

function joinNotes(...notes: (string | null)[]): string | undefined {
  const kept = notes.filter((note): note is string => Boolean(note));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/**
 * Decide which candidate lockup — if any — to propose.
 *
 * Three outcomes, and the middle one is the reason this exists:
 *
 *  - **Checked and matched.** The model read a wordmark and it names the site. High confidence,
 *    with what it read shown to the admin so they can disagree at a glance.
 *  - **Checked and rejected.** It read somebody else's name. Nothing is proposed, and the note says
 *    what it read — a wrong logo accepted without looking is exactly the failure being fixed here,
 *    and it is not made acceptable by a "low confidence" label.
 *  - **Not checked.** No vision model, or the call failed. The harvest's own ranking is proposed at
 *    low confidence, saying it was not verified — an unchecked guess still beats no logo, as long
 *    as it admits to being one.
 */
async function chooseLogo(
  brand: HarvestedBrand,
  demoClientId?: string
): Promise<{ field: Partial<Record<ImportableField, ProposedField>>; note: string | null }> {
  // Light and dark candidates go into ONE call. The dark slot is where a bad pick does the most
  // damage — the header band prefers the dark lockup whenever its ground is dark, so a wrong image
  // there replaces the right one everywhere a branded client actually looks.
  const candidates = [...brand.logoCandidates, ...brand.logoDarkCandidates];
  if (candidates.length === 0) return { field: {}, note: null };

  const withBytes = candidates.flatMap((candidate) => {
    const buffer = brand.logoImages.get(candidate.url);
    return buffer ? [{ url: candidate.url, buffer }] : [];
  });

  const verdict = await verifyLogo({
    candidates: withBytes,
    siteName: brand.siteName,
    demoClientId,
  });

  if (!verdict) {
    const fallback = brand.logoCandidates[0];
    if (!fallback) return { field: {}, note: null };
    return {
      field: {
        logoUrl: {
          value: fallback.url,
          confidence: 'low',
          source: `${IMAGE_SOURCE_COPY[fallback.via]} — we could not check it, so look before you accept it`,
        },
      },
      note: null,
    };
  }

  if (!verdict.url) {
    return { field: {}, note: verdict.reason };
  }

  const field: Partial<Record<ImportableField, ProposedField>> = {
    logoUrl: { value: verdict.url, confidence: verdict.confidence, source: verdict.reason },
  };
  if (verdict.darkUrl) {
    field.logoDarkUrl = {
      value: verdict.darkUrl,
      confidence: verdict.confidence,
      source: 'the same lockup drawn for a dark background',
    };
  }

  return { field, note: null };
}
