/**
 * Brand import — look at the candidate logos and decide which one is actually the company's.
 *
 * ## The problem this exists for
 *
 * Every signal the harvest can see is circumstantial: a filename containing "logo", a position in
 * the header, a `schema.org` claim. A marketing homepage is full of images that satisfy all three
 * and belong to somebody else — press badges, review-site marks, partner and customer strips. The
 * deterministic exclusions in `harvest.ts` catch the named ones, and they will never catch all of
 * them, because the next site's badge is a company nobody has heard of.
 *
 * So this reads the images. The one question the heuristics cannot answer is the one a person
 * answers instantly: *does this lockup say the company's name?*
 *
 * ## The model reads; the code decides
 *
 * Same split as the colour analyst. The model is asked what the wordmark SAYS — a transcription
 * task, which it is good at — and the match against the site's own name is then done in code. A
 * model asked "is this their logo?" will happily agree; a model asked "what does it say?" returns
 * `Forbes`, and `Forbes` does not match `Eagle Eye Solutions` by any string comparison we run.
 *
 * That is also why a mismatch **rejects the candidate outright** rather than downgrading it. A
 * wrong logo proposed at low confidence is still a wrong logo, and this feature's failure mode is
 * an admin accepting one without looking. Proposing nothing is a worse-looking result and a better
 * one: the admin uploads the file they can find in ten seconds.
 *
 * A purely graphical mark reads as no text at all. That is not a failure — it is most abstract
 * logos — so those are proposed with low confidence and a line saying we could not read them.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import sharp from 'sharp';
import { z } from 'zod';

import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import {
  assertModelSupportsAttachments,
  getProvider,
} from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import type { ContentPart, LlmMessage } from '@/lib/orchestration/llm/types';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import { bulletList, joinSections, titledBlock } from '@/lib/app/questionnaire/prompt/format';
import { BRAND_IMPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { MAX_INPUT_PIXELS } from '@/lib/app/questionnaire/theming';

const MAX_TOKENS = 400;
const TIMEOUT_MS = 30_000;

/**
 * Width each candidate is scaled to before it is attached.
 *
 * A wordmark is legible well below its native size, and every extra pixel is tokens on a call that
 * carries up to four images. 240px keeps "eagleeye" readable and a 2000px hero from costing more
 * than the rest of the import put together.
 */
const THUMB_WIDTH = 240;

export interface LogoCandidateInput {
  url: string;
  buffer: Buffer;
}

export interface LogoVerdict {
  /** The candidate to propose, or null when none of them is this company's logo. */
  url: string | null;
  confidence: 'high' | 'low';
  /** Admin-facing provenance, e.g. "the lockup reads “eagleeye”". */
  reason: string;
  /**
   * The same lockup drawn for a dark ground, when one of the images is that.
   *
   * Checked in the SAME call rather than trusted from the filename, because the dark slot is where
   * a bad pick does the most damage: the header band prefers the dark lockup whenever its ground is
   * dark, so a wrong image here replaces the right one everywhere a branded client actually looks.
   * Null whenever the light lockup itself was rejected — a "dark variant" of somebody else's logo
   * is not a thing worth proposing.
   */
  darkUrl: string | null;
}

const verdictSchema = z.object({
  index: z.number().int().nullable(),
  /** What the lockup says, verbatim. Null for a purely graphical mark. */
  wordmark: z.string().nullable().optional(),
  /** The same lockup drawn light-on-dark, if one of the images is that. */
  darkIndex: z.number().int().nullable().optional(),
});

/**
 * Pick the company's own lockup from the candidates.
 *
 * Returns null when the check could not run at all — no provider, no vision-capable model, an
 * unparseable reply. The caller then falls back to the harvest's own ranking at low confidence,
 * because an unchecked guess is still better than no logo, as long as it says so.
 */
export async function verifyLogo(params: {
  candidates: LogoCandidateInput[];
  siteName: string | null;
  demoClientId?: string;
}): Promise<LogoVerdict | null> {
  if (params.candidates.length === 0) return null;

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: BRAND_IMPORT_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true, temperature: true },
  });
  if (!agent) return null;

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'chat');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
    // Reading a wordmark is the whole job here — unlike the colour analyst, there is no useful
    // answer without sight, so this returns null rather than degrading.
    await assertModelSupportsAttachments(providerSlug, model, ['vision']);
  } catch (error) {
    logger.info('Brand import: cannot check the logo — no vision model available', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const thumbs = await Promise.all(params.candidates.map((c) => thumbnail(c.buffer)));
  const attachable = params.candidates
    .map((candidate, index) => ({ candidate, index, thumb: thumbs[index] }))
    .filter(
      (entry): entry is { candidate: LogoCandidateInput; index: number; thumb: Buffer } =>
        entry.thumb !== null
    );
  if (attachable.length === 0) return null;

  let value: z.infer<typeof verdictSchema>;
  try {
    const result = await runStructuredCompletion<z.infer<typeof verdictSchema>>({
      provider: await getProvider(providerSlug),
      model,
      messages: buildMessages(
        params.siteName,
        attachable.map((entry) => entry.thumb)
      ),
      temperature: agent.temperature,
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
      parse: (raw) => tryParseJson(raw, (parsed) => verdictSchema.safeParse(parsed).data ?? null),
      retryUserMessage:
        'Respond with ONLY {"index": <number or null>, "wordmark": "<text or null>", ' +
        '"darkIndex": <number or null>} — no prose.',
      responseSchema: RESPONSE_SCHEMA,
      responseSchemaName: 'logo_check',
      phase: 'brand-import-logo',
    });
    value = result.value;

    logAppLlmCost({
      agentId: agent.id,
      provider: providerSlug,
      model,
      tokenUsage: result.tokenUsage,
      capability: 'app_brand_import_logo',
      versionId: null,
      extra: { candidates: attachable.length, demoClientId: params.demoClientId },
    });
  } catch (error) {
    logger.info('Brand import: the logo check did not complete', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return judge(value, attachable, params.siteName);
}

/**
 * Turn the model's reading into a verdict.
 *
 * Exported for its own test: the matching is the part that decides whether a Forbes badge reaches
 * the admin, and it is deliberately code rather than a question put to the model.
 */
export function judge(
  value: { index: number | null; wordmark?: string | null; darkIndex?: number | null },
  attachable: { candidate: LogoCandidateInput; index: number }[],
  siteName: string | null
): LogoVerdict {
  const inRange = (index: number | null | undefined): boolean =>
    typeof index === 'number' && index >= 0 && index < attachable.length;

  if (!inRange(value.index)) {
    return {
      url: null,
      confidence: 'low',
      reason: 'None of the images on that page looked like the company’s own logo.',
      darkUrl: null,
    };
  }

  const chosen = attachable[value.index as number].candidate;
  const wordmark = value.wordmark?.trim() || null;

  // A dark variant is only meaningful alongside an accepted lockup, and only when it is a
  // DIFFERENT image — a model that repeats the index is saying "there isn't one".
  const darkUrl =
    inRange(value.darkIndex) && value.darkIndex !== value.index
      ? attachable[value.darkIndex as number].candidate.url
      : null;

  if (!wordmark) {
    // Most abstract marks. Not a failure, but not a confirmation either.
    return {
      url: chosen.url,
      confidence: 'low',
      reason: 'the logo we found on the page — we could not read a name in it, so check it',
      darkUrl,
    };
  }

  if (!namesMatch(wordmark, siteName)) {
    return {
      url: null,
      confidence: 'low',
      reason:
        `The logo on that page reads “${wordmark}”, which is not ${siteName ?? 'the site'} — ` +
        'it is probably a press or partner badge. Upload the real one.',
      darkUrl: null,
    };
  }

  return {
    url: chosen.url,
    confidence: 'high',
    reason: `the lockup on the page, which reads “${wordmark}”`,
    darkUrl,
  };
}

/**
 * Does the text in the lockup name this company?
 *
 * Compared on letters and digits alone, so "eagleeye" matches "Eagle Eye Solutions" and
 * "eagle-eye.com" — a wordmark is set as artwork, and its spacing, casing and punctuation carry no
 * information about whose it is. Containment either way, because a lockup is routinely shorter than
 * a legal name ("eagleeye" for "Eagle Eye Solutions Ltd") and occasionally longer.
 */
export function namesMatch(wordmark: string, siteName: string | null): boolean {
  if (!siteName) return false;

  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mark = normalise(wordmark);
  const site = normalise(siteName);
  if (mark.length < 2 || site.length < 2) return false;

  return mark.includes(site) || site.includes(mark);
}

/** Scale one candidate down for attachment, or null when it cannot be decoded. */
async function thumbnail(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      // Flattened onto white: a white wordmark on transparency is invisible to a model that
      // composites onto black, which is exactly the artwork a header lockup usually is.
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    index: {
      type: ['integer', 'null'],
      description: 'Which image is the company’s own logo, or null if none of them is.',
    },
    wordmark: {
      type: ['string', 'null'],
      description: 'The text in that logo, exactly as written. Null for a graphics-only mark.',
    },
    darkIndex: {
      type: ['integer', 'null'],
      description: 'The same logo drawn light-on-dark, if one of the images is that. Else null.',
    },
  },
  required: ['index'],
};

function buildMessages(siteName: string | null, thumbs: Buffer[]): LlmMessage[] {
  const system = joinSections(
    'You identify a company’s own logo among images taken from its website.',
    bulletList([
      'Read any text in each image and report it EXACTLY as written, including spacing and case.',
      'Websites are full of other companies’ logos — press mentions, review sites, partners, ' +
        'customers, awards. Those are never the answer.',
      'If none of the images is the company’s own logo, return null for the index. That is a ' +
        'normal answer and a much better one than picking the closest.',
      'Return the wordmark as null when the image is purely graphical with no readable text.',
      'Some sites ship the SAME lockup twice — once in dark ink for light backgrounds, once in ' +
        'light ink for dark ones. If one of the images is that second version of the logo you ' +
        'chose, give its position as darkIndex. Otherwise return null: a different image that ' +
        'merely happens to be light-on-dark is not it.',
    ])
  );

  const count = thumbs.length;
  const text = joinSections(
    titledBlock('The company', siteName ?? '(unknown — judge from the images alone)'),
    `${count} image${count === 1 ? '' : 's'} follow${count === 1 ? 's' : ''}, in order, starting at index 0.`,
    'Which one is this company’s own logo, what does it say, and is one of the others the same ' +
      'lockup drawn for a dark background?'
  );

  // Text first, then the images in index order — the indices in the prompt are positional, so the
  // order of these parts IS the contract the reply is read against.
  const parts: ContentPart[] = [
    { type: 'text', text },
    ...thumbs.map((thumb): ContentPart => ({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: thumb.toString('base64') },
    })),
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
}
