/**
 * Brand import — assign the measured colours to theme columns.
 *
 * The one model call in the feature, and the narrowest one we could make it. It is handed a palette
 * that has already been MEASURED (`palette.ts`) and asked a single question: which of these colours
 * is the page's ground, which is its text, which is the button, which is the accent?
 *
 * ## Why a model at all
 *
 * Ranking by area answers the wrong question. On a screenshot the largest cluster is the white
 * background — correct for `canvasColor`, useless for everything else — and nothing in the numbers
 * separates a brand accent from a border grey or a link blue from a warning red. Role assignment is
 * a judgement about how a page is laid out, which is exactly what a vision model can make and a
 * histogram cannot.
 *
 * ## Why it cannot invent a colour
 *
 * An unconstrained model returns confident, plausible, wrong hexes — brand colours that were never
 * on the page. So the reply is filtered against the candidate list by exact string match, and
 * anything that is not in it is DROPPED rather than corrected to the nearest neighbour. Correcting
 * would hide the failure and still ship a colour the page never used; dropping it means the field
 * is simply not proposed, which is the honest answer and the one the result contract is built for.
 *
 * ## Degradation
 *
 * Three separate things can be missing — a provider, a vision-capable model, a parseable reply —
 * and none of them is fatal. Without a vision model the image is dropped and the call runs on the
 * numbers alone. Without a provider (or after a failed call) the caller falls back to the measured
 * palette with `degraded: true`. The admin always gets the colours; only the mapping is at risk.
 */

import sharp from 'sharp';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
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
import { HEX_COLOR_PATTERN, MAX_INPUT_PIXELS } from '@/lib/app/questionnaire/theming';
import type {
  ColorCandidate,
  ImportableColorField,
} from '@/lib/app/questionnaire/brand-import/result';

const MAX_TOKENS = 700;
const TIMEOUT_MS = 30_000;

/**
 * The longest edge, in pixels, of a screenshot as it goes to the model.
 *
 * 1568 is the providers' OWN downscale threshold — an image longer than this on either edge is
 * resized before it is ever tokenised, so shipping the full frame buys no detail and costs the
 * upload. What it did cost was real: the route accepts up to {@link MAX_SCREENSHOTS} frames at the
 * storage size cap each, and base64 adds a third again, so three large screenshots could exceed a
 * provider's per-image limit outright and fail the whole call — losing the assignment we could
 * still have made from the numbers.
 *
 * `fit: 'inside'` so it bounds the LONG edge whichever one that is. A full-page screenshot is tall,
 * not wide, and capping only the width would leave it enormous.
 */
const VISION_MAX_EDGE = 1568;

/**
 * The roles the analyst assigns, and the column each one lands in.
 *
 * Named for what they DO on the page rather than for the column, because the model is reasoning
 * about a website it can see, not about our schema — "the deep band across the top" is a thing it
 * can find, `surfaceColor` is not. The map is the single place the two vocabularies meet.
 */
const ROLE_TO_FIELD: Record<string, ImportableColorField> = {
  pageBackground: 'canvasColor',
  bodyText: 'inkColor',
  darkPageBackground: 'canvasColorDark',
  darkBodyText: 'inkColorDark',
  primaryButton: 'ctaColor',
  primaryButtonGradientEnd: 'ctaColorEnd',
  accent: 'accentColor',
  secondaryAccent: 'accentColorEnd',
  headerBand: 'surfaceColor',
  logoBackdrop: 'logoBackgroundColor',
};

const ROLE_NAMES = Object.keys(ROLE_TO_FIELD);

/** Admin-facing description of each role, used in the prompt and nowhere else. */
const ROLE_BRIEF: Record<string, string> = {
  pageBackground: 'the ground the page is drawn on — usually the largest area by far',
  bodyText: 'the colour running text is set in on that ground',
  darkPageBackground:
    'the ground for DARK mode — a deeper tone from the same brand, clearly darker than the light ' +
    'ground. Only if the palette actually contains one; it is derived otherwise',
  darkBodyText: 'the colour text is set in on that dark ground — usually a near-white',
  primaryButton: "the brand's main call-to-action colour (the primary button)",
  primaryButtonGradientEnd:
    'the second colour of the button gradient, ONLY if the button is visibly a gradient',
  accent: 'the brand colour used for links, highlights and small emphatic details',
  secondaryAccent: 'a second brand colour used alongside the accent, only if there clearly is one',
  headerBand: 'a deep brand colour filling a band or bar across the top, only if there is one',
  logoBackdrop: 'the colour sitting immediately behind the logo, if it differs from the ground',
};

/** What the analyst returns. Every role optional — "there isn't one" is a real answer. */
const assignmentSchema = z.object({
  roles: z.record(z.string(), z.string().nullable()).optional(),
});

export interface RoleAssignment {
  field: ImportableColorField;
  hex: string;
}

export interface AssignRolesInput {
  candidates: ColorCandidate[];
  /** The client this import is for, when there is one — absent on the create form. Cost context. */
  demoClientId?: string;
  /**
   * Screenshots to reason over, when we have any and a vision model to read them.
   *
   * A list rather than one image because an admin can show us more of the site than one frame
   * holds — a hero, an interior page, a form. They go into a SINGLE call: the roles are one
   * decision about one brand, and asking per image would produce N answers with nothing to
   * arbitrate between them.
   */
  images?: Buffer[];
  /**
   * Things the page told us outright — a `theme-color` meta, a `--brand-primary` custom property.
   * Passed as hints rather than applied directly so the analyst can reconcile them with what it
   * sees; a declared theme-color is frequently a leftover from a previous rebrand.
   */
  hints?: string[];
}

export interface AssignRolesResult {
  assignments: RoleAssignment[];
  provider: string;
  model: string;
  /** False when the images were dropped because the resolved model cannot read one. */
  sawImages: boolean;
}

/**
 * Run one role-assignment pass.
 *
 * Throws only when the agent is unseeded or no provider is configured — the caller treats that as
 * "degraded", not as a failed import. A reply we cannot parse is NOT a throw: the structured runner
 * already retried, and an unparseable second attempt means the same thing as an empty assignment.
 */
export async function assignRoles(input: AssignRolesInput): Promise<AssignRolesResult> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: BRAND_IMPORT_AGENT_SLUG },
    select: {
      id: true,
      provider: true,
      model: true,
      fallbackProviders: true,
      systemInstructions: true,
      temperature: true,
      maxTokens: true,
    },
  });
  if (!agent) throw new Error('Brand import analyst is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'chat');
  const provider = await getProvider(providerSlug);

  // Ask before attaching: a model without `vision` in the curated matrix would reject the whole
  // call, losing the assignment we could still have made from the numbers alone.
  let sawImages = false;
  let attachable: string[] = [];
  if (input.images && input.images.length > 0) {
    try {
      await assertModelSupportsAttachments(providerSlug, model, ['vision']);
      // Only once vision is confirmed: re-encoding frames a model cannot read is pure waste.
      attachable = (await Promise.all(input.images.map(forVision))).filter(
        (encoded): encoded is string => encoded !== null
      );
      sawImages = attachable.length > 0;
      if (!sawImages) {
        logger.info('Brand import: no screenshot could be prepared for the model', {
          providerSlug,
          model,
        });
      }
    } catch {
      logger.info('Brand import: resolved model cannot read images, assigning from palette only', {
        providerSlug,
        model,
      });
    }
  }

  const result = await runStructuredCompletion<z.infer<typeof assignmentSchema>>({
    provider,
    model,
    messages: buildMessages(input, attachable),
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, validateAssignment),
    retryUserMessage:
      'Respond with ONLY the JSON object {"roles": {"<role>": "#rrggbb" | null}} using hex values ' +
      'copied exactly from the candidate list — no prose, no code fence.',
    responseSchema: RESPONSE_SCHEMA,
    responseSchemaName: 'brand_roles',
    phase: 'brand-import',
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_brand_import',
    // Genuinely version-less: a brand import belongs to a demo client, not to any questionnaire
    // version. The demo client rides in `extra` so the spend is still attributable.
    versionId: null,
    extra: {
      candidates: input.candidates.length,
      images: attachable.length,
      demoClientId: input.demoClientId,
    },
  });

  return {
    assignments: narrowAssignments(result.value.roles ?? {}, input.candidates),
    provider: providerSlug,
    model,
    sawImages,
  };
}

/**
 * Keep only assignments naming a role we asked for and a hex we measured.
 *
 * Exported for its own test: this function is the whole "the model cannot invent a colour"
 * guarantee, and a guarantee that is only exercised through a mocked provider is a guarantee
 * nobody is really checking.
 */
export function narrowAssignments(
  roles: Record<string, string | null>,
  candidates: ColorCandidate[]
): RoleAssignment[] {
  const measured = new Set(candidates.map((candidate) => candidate.hex.toLowerCase()));
  const assignments: RoleAssignment[] = [];
  const used = new Set<ImportableColorField>();

  for (const [role, value] of Object.entries(roles)) {
    const field = ROLE_TO_FIELD[role];
    if (!field || used.has(field)) continue;
    if (typeof value !== 'string') continue;

    const hex = value.trim().toLowerCase();
    if (!HEX_COLOR_PATTERN.test(hex)) continue;
    // The measured list is the only source of truth. A near-miss is a fabrication, not a typo:
    // snapping it to the closest candidate would ship a colour the page never used while looking
    // exactly like one it did.
    if (!measured.has(hex)) {
      logger.info('Brand import: discarded a colour the analyst did not measure', { role, hex });
      continue;
    }

    assignments.push({ field, hex });
    used.add(field);
  }

  return assignments;
}

function validateAssignment(parsed: unknown): z.infer<typeof assignmentSchema> | null {
  const result = assignmentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    roles: {
      type: 'object',
      description: 'Role name → a hex copied exactly from the candidate list, or null.',
      properties: Object.fromEntries(
        ROLE_NAMES.map((role) => [
          role,
          { type: ['string', 'null'], description: ROLE_BRIEF[role] },
        ])
      ),
    },
  },
  required: ['roles'],
};

/**
 * One screenshot, resized and re-encoded for the model. Base64 PNG, or null if it cannot be read.
 *
 * PNG rather than JPEG deliberately. This whole feature is about colour, and while the model can
 * only ever RETURN a hex from the measured candidate list — `narrowAssignments` guarantees that, so
 * a shifted pixel could never become a fabricated colour — a lossy encode could still blur which
 * region is which and move a colour onto the wrong ROLE. A UI screenshot is flat colour, which is
 * exactly what PNG compresses well, so losslessness costs little here. The resize is what does the
 * work: capping the long edge at {@link VISION_MAX_EDGE} takes a 4000x3000 frame down by a factor
 * of six in pixels.
 *
 * Flattened onto white because a screenshot can arrive as a PNG with alpha, and a provider that
 * composites onto black would be shown a page nobody has ever seen.
 *
 * Returns null rather than throwing: one undecodable frame among three is not a reason to lose the
 * other two, and no frames at all simply drops us to assigning from the numbers.
 */
async function forVision(buffer: Buffer): Promise<string | null> {
  try {
    const resized = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({
        width: VISION_MAX_EDGE,
        height: VISION_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
    return resized.toString('base64');
  } catch (error) {
    logger.info('Brand import: a screenshot could not be prepared for the model', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildMessages(input: AssignRolesInput, images: string[]): LlmMessage[] {
  const system = joinSections(
    'You are a brand analyst. You are given the colours MEASURED from a company website (or a ' +
      'screenshot of one) and you decide which role each colour plays on the page.',
    'Rules you must follow:',
    bulletList([
      'Every value you return must be copied EXACTLY from the candidate list. Never adjust, ' +
        'round, or invent a colour — if the right colour is not in the list, return null.',
      'Return null for any role the page does not have. Most pages have no header band, no ' +
        'button gradient and no second accent. Guessing one is worse than leaving it out.',
      'The questionnaire is rendered in BOTH light and dark mode, so the two grounds must be ' +
        'clearly different from each other. If the palette has no genuinely darker tone, return ' +
        'null for the dark roles rather than repeating the light ground — a derived one is used.',
      'Text must READ on the ground you put it on. A dark text colour on a dark ground will be ' +
        'discarded, so return null instead when nothing in the list reads.',
      'The page background is almost always the colour with the largest share. The body text is ' +
        'almost always a dark near-neutral (or a light one on a dark page).',
      'A colour flagged as neutral is a grey, white, near-black or a tinted paper stock. Those ' +
        'are candidates for the background and the text, rarely for the accent or the button.',
      'Never assign the same colour to two roles.',
    ])
  );

  const candidateLines = input.candidates.map(
    (candidate) =>
      `${candidate.hex} — ${(candidate.share * 100).toFixed(1)}% of the image${
        candidate.neutral ? ', neutral' : ''
      }`
  );

  const text = joinSections(
    titledBlock('Roles to fill', bulletList(ROLE_NAMES.map((r) => `${r}: ${ROLE_BRIEF[r]}`))),
    titledBlock('Candidate colours (the only values you may return)', bulletList(candidateLines)),
    input.hints && input.hints.length > 0
      ? titledBlock('What the page declared about itself', bulletList(input.hints))
      : '',
    images.length > 0
      ? `${
          images.length === 1
            ? 'The screenshot is attached.'
            : `${images.length} screenshots of the same site are attached.`
        } Use what you can see — where each colour actually appears — rather than area alone.` +
          (images.length > 1
            ? ' They are different views of ONE brand, so return one set of roles covering all of ' +
              'them, not one per image.'
            : '')
      : 'No image is available, so reason from the shares and the neutral flags.',
    'Assign the roles now.'
  );

  if (images.length === 0) {
    return [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ];
  }

  const parts: ContentPart[] = [
    { type: 'text', text },
    // `image/png` is asserted, not detected: these are bytes WE encoded a line above, so the type
    // is ours rather than anything the upload claimed about itself.
    ...images.map((data): ContentPart => ({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data },
    })),
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
}
