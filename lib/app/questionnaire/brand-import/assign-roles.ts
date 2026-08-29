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
import { HEX_COLOR_PATTERN } from '@/lib/app/questionnaire/theming';
import type {
  ColorCandidate,
  ImportableColorField,
} from '@/lib/app/questionnaire/brand-import/result';

const MAX_TOKENS = 700;
const TIMEOUT_MS = 30_000;

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
  /** A screenshot or page image to reason over, when we have one and a vision model to read it. */
  image?: { base64: string; mediaType: string };
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
  /** False when the image was dropped because the resolved model cannot read one. */
  sawImage: boolean;
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
  let sawImage = false;
  if (input.image) {
    try {
      await assertModelSupportsAttachments(providerSlug, model, ['vision']);
      sawImage = true;
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
    messages: buildMessages(input, sawImage),
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
    extra: { candidates: input.candidates.length, sawImage, demoClientId: input.demoClientId },
  });

  return {
    assignments: narrowAssignments(result.value.roles ?? {}, input.candidates),
    provider: providerSlug,
    model,
    sawImage,
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

function buildMessages(input: AssignRolesInput, sawImage: boolean): LlmMessage[] {
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
    sawImage
      ? 'The screenshot is attached. Use what you can see — where each colour actually appears — ' +
          'rather than area alone.'
      : 'No image is available, so reason from the shares and the neutral flags.',
    'Assign the roles now.'
  );

  if (!sawImage || !input.image) {
    return [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ];
  }

  const parts: ContentPart[] = [
    { type: 'text', text },
    {
      type: 'image',
      source: { type: 'base64', mediaType: input.image.mediaType, data: input.image.base64 },
    },
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
}
