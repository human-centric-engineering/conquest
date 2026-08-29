/**
 * Brand import — the two entry points.
 *
 * Measure a palette, ask the analyst which colour plays which role, annotate the pair that has to
 * read against itself, and return the shared result contract. The URL path adds a harvest in front
 * of that and proposes images and a typeface as well; everything below the harvest is shared.
 *
 * The screenshot route exists because we cannot render a website server-side. Playwright is a dev
 * dependency and Chromium on a serverless function is a size-and-cold-start fight we would lose;
 * meanwhile the admin's own browser has already rendered the page perfectly. So when a URL import
 * is blocked — a bot wall, a login, a heavy SPA — the answer is not a better fetcher, it is to ask
 * for the picture the admin can already see. That is why `blockedResult` always points here.
 */

import { logger } from '@/lib/logging';

import {
  analysedResult,
  blockedResult,
  type BrandImportResult,
  type ColorCandidate,
  type ImportableField,
  type ProposedField,
} from '@/lib/app/questionnaire/brand-import/result';
import { extractPalette } from '@/lib/app/questionnaire/brand-import/palette';
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

export interface ScreenshotInput {
  buffer: Buffer;
  /** The type the magic-byte check DETECTED, never the one the browser claimed. */
  mediaType: string;
  /** The client this import is for, when the form has one. Threaded through for cost attribution. */
  demoClientId?: string;
}

/**
 * Analyse a screenshot into proposed theme fields.
 *
 * Never throws for an ordinary failure. An undecodable image, an unseeded agent and an unreachable
 * provider all resolve to a result the dialog can render — `empty` with a next step, or the
 * measured palette marked `degraded`. The only thing that reaches the route as an exception is a
 * genuine defect.
 */
export async function analyseScreenshot(input: ScreenshotInput): Promise<BrandImportResult> {
  const candidates = await extractPalette(input.buffer);

  if (candidates.length === 0) {
    return analysedResult({ source: 'screenshot', fields: {}, candidates: [], degraded: false });
  }

  let assignments: RoleAssignment[] = [];
  let sawImage = false;
  let degraded = false;

  try {
    const assigned = await assignRoles({
      candidates,
      demoClientId: input.demoClientId,
      image: { base64: input.buffer.toString('base64'), mediaType: input.mediaType },
    });
    assignments = assigned.assignments;
    sawImage = assigned.sawImage;
  } catch (error) {
    // Expected in a deployment with no provider configured, and after a provider outage. The
    // palette is the expensive part and it is already in hand, so this degrades rather than fails.
    degraded = true;
    logger.info('Brand import: role assignment unavailable, returning the measured palette', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // `completeGrounds` before `annotateContrast`: it drops an unreadable ink and fills the dark
  // pair, so by the time the contrast annotation runs there is nothing left for it to warn about
  // unless the admin's own later edits create it.
  const fields = annotateContrast(
    completeGrounds(
      assignmentsToFields(assignments, {
        confidence: sawImage ? 'high' : 'low',
        source: sawImage
          ? 'read from the screenshot'
          : 'inferred from the screenshot’s palette (no image model available)',
      })
    )
  );

  return analysedResult({
    source: 'screenshot',
    fields,
    candidates,
    degraded,
    note: degraded
      ? 'We measured the colours but could not work out which is which — no AI provider was available. Pick from the palette below.'
      : undefined,
  });
}

/**
 * Turn role assignments into the result's field bag.
 *
 * Shared with the URL path, which assigns the same way over a differently-sourced palette.
 */
export function assignmentsToFields(
  assignments: RoleAssignment[],
  provenance: { confidence: ProposedField['confidence']; source: string }
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};
  for (const assignment of assignments) {
    fields[assignment.field] = {
      value: assignment.hex,
      confidence: provenance.confidence,
      source: provenance.source,
    };
  }
  return fields;
}

/** Re-exported so the route can render a palette-only answer without reaching past this module. */
export type { ColorCandidate };

/**
 * Analyse a live website into proposed theme fields.
 *
 * The failure surface is much wider than the screenshot path's — a bot wall, a login, an
 * unresolvable host, a page that is really a PDF — so every one of those comes back as `blocked`
 * with a sentence naming what happened and the screenshot route offered. The admin's browser can
 * render what we cannot; that is the whole reason the other entry point exists.
 */
export async function analyseUrl(input: {
  url: string;
  demoClientId?: string;
}): Promise<BrandImportResult> {
  const harvested = await harvestSite(input.url);
  if (!harvested.ok) {
    return blockedResult({ source: 'url', reason: harvested.reason });
  }

  const { brand } = harvested;

  // The lockup is CHECKED, not just ranked: every signal the harvest can see is circumstantial, and
  // a press badge named `logo.svg` satisfies all of them. See verify-logo.ts.
  const logo = await chooseLogo(brand, input.demoClientId);

  // Images and type are found by parsing, not by measuring, so they are worth proposing even when
  // the page gave up no usable colours at all — a logo alone is a real result.
  const fields: Partial<Record<ImportableField, ProposedField>> = {
    ...logo.field,
    ...imageFields(brand.mark, brand.logoDark),
    ...fontField(brand.fontFamilies),
  };

  let degraded = false;
  if (brand.candidates.length > 0) {
    try {
      const assigned = await assignRoles({
        candidates: brand.candidates,
        demoClientId: input.demoClientId,
        hints: brand.hints,
      });
      Object.assign(fields, colourFields(assigned.assignments, brand.declared));
    } catch (error) {
      degraded = true;
      logger.info('Brand import: role assignment unavailable for a site harvest', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return analysedResult({
    source: 'url',
    fields: annotateContrast(completeGrounds(fields)),
    candidates: brand.candidates,
    degraded,
    note: joinNotes(
      brand.note,
      logo.note,
      degraded
        ? 'We read the site but could not work out which colour is which — no AI provider was available. Pick from the palette below.'
        : null
    ),
  });
}

/**
 * Turn colour assignments into proposals, splitting confidence by how we came to know the colour.
 *
 * A hex the site DECLARED — as `theme-color`, or as a `--brand-primary` custom property — is the
 * site asserting its own brand, and is reported as high confidence with that reason attached.
 * Everything else was ranked out of pixels and stylesheet frequency by a model that could not see
 * the page, which is a genuine guess and is labelled as one. Flattening the two would tell an admin
 * that a border grey we happened to rank third is as certain as the colour the site named.
 */
function colourFields(
  assignments: RoleAssignment[],
  declared: Set<string>
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};
  for (const assignment of assignments) {
    const wasDeclared = declared.has(assignment.hex);
    fields[assignment.field] = {
      value: assignment.hex,
      confidence: wasDeclared ? 'high' : 'low',
      source: wasDeclared
        ? 'the site declares this colour as part of its brand'
        : 'measured from the site’s logo and stylesheets',
    };
  }
  return fields;
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
  mark: DiscoveredImage | null,
  logoDark: DiscoveredImage | null
): Partial<Record<ImportableField, ProposedField>> {
  const fields: Partial<Record<ImportableField, ProposedField>> = {};

  for (const [field, image] of [
    ['logoMarkUrl', mark],
    ['logoDarkUrl', logoDark],
  ] as const) {
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
  const candidates = brand.logoCandidates;
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
    const fallback = candidates[0];
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

  return {
    field: {
      logoUrl: { value: verdict.url, confidence: verdict.confidence, source: verdict.reason },
    },
    note: null,
  };
}
