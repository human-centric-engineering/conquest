/**
 * Contrast optimiser — the advice.
 *
 * `audit.ts` has already decided what is possible: which pairs fail, and for each one the exact
 * shades — hue and saturation untouched — that would fix it. What is left is the judgement, and it
 * is a real one. Body text that fails on a cream page can be fixed by darkening the ink or by
 * bleaching the paper, and those are not equivalent: for a brand whose site is recognisable BY its
 * paper stock, one of them is a rebrand and the other is a tweak. Nothing in the arithmetic knows
 * that, and a designer would.
 *
 * ## The model picks an index, not a colour
 *
 * The same guarantee the import analyst has, for the same reason. It is handed a numbered list of
 * repairs it did not write and returns a number; anything outside the list is dropped and the
 * deterministic pick stands. It therefore cannot propose a colour that has not been PROVED to fix
 * the pair — the failure mode this whole design exists to make impossible is a confident,
 * plausible, unreadable hex.
 *
 * The rationale is the one thing it genuinely authors, and it is prose shown beside a swatch the
 * admin can see, so a wrong sentence is visibly wrong rather than silently wrong.
 *
 * ## Unavailable is not broken
 *
 * No provider, no agent, an unparseable reply: the optimiser still answers. `recommendDefault`
 * ranks by how little the brand moves, which is the right default and the reason the repair list is
 * already sorted that way. The result is marked `degraded` and the dialog says the picks are ours.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { z } from 'zod';

import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import { bulletList, joinSections, titledBlock } from '@/lib/app/questionnaire/prompt/format';
import { BRAND_CONTRAST_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { AuditedPair } from '@/lib/app/questionnaire/brand-contrast/audit';
import type {
  ContrastProposal,
  ContrastRepair,
} from '@/lib/app/questionnaire/brand-contrast/result';

const MAX_TOKENS = 900;
const TIMEOUT_MS = 30_000;

/** Longest rationale we will show. Beyond this it stops being a line beside a swatch. */
const RATIONALE_MAX = 240;

/** What the adviser returns: one pick per finding, by pair id. */
const adviceSchema = z.object({
  picks: z
    .array(
      z.object({
        pair: z.string(),
        repair: z.number(),
        why: z.string(),
      })
    )
    .optional(),
});

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      description: 'One entry per problem, in the order they were given.',
      items: {
        type: 'object',
        properties: {
          pair: { type: 'string', description: 'The problem id, copied exactly.' },
          repair: {
            type: 'integer',
            description: 'The number of the fix you are choosing, from that problem’s own list.',
          },
          why: {
            type: 'string',
            description:
              'One sentence, for a non-designer, saying why this fix and not the others. No hex codes.',
          },
        },
        required: ['pair', 'repair', 'why'],
      },
    },
  },
  required: ['picks'],
};

export interface AdviseInput {
  audited: AuditedPair[];
  /** The client this is for, when there is one — absent on the create form. Cost context only. */
  demoClientId?: string;
}

export interface AdviseResult {
  proposals: ContrastProposal[];
  degraded: boolean;
}

/**
 * The default pick: the repair that moves the brand least.
 *
 * The list is already sorted nearest-first, so this is index 0 — but it is a named function rather
 * than a bare zero because it is the FALLBACK POLICY, and a policy deserves somewhere to live and
 * a sentence explaining itself.
 */
export function recommendDefault(pair: AuditedPair): ContrastProposal {
  return {
    finding: pair.finding,
    repairs: pair.repairs,
    chosen: 0,
    rationale: describeRepair(pair.repairs[0], true),
  };
}

/**
 * A plain sentence saying what a repair does — the stand-in for advice we could not get.
 *
 * Takes the repair rather than the pair, so it always describes the change actually CHOSEN. Written
 * against `pair.repairs[0]` instead, it silently misdescribed the model's pick whenever the model
 * chose a different one and gave no reason of its own: "the smallest change: a deeper shade of the
 * text", printed under a proposal that moves the page.
 */
export function describeRepair(repair: ContrastRepair, isSmallest: boolean): string {
  const subject = repair.field.startsWith('canvas')
    ? 'the page it sits on'
    : repair.field.startsWith('ink')
      ? 'the text'
      : 'the colour itself';

  // Read straight off the signed ramp position. An earlier draft compared the two hexes as
  // strings, which reads `#ff0000` as lighter than `#00ff00` and would have told the admin a
  // colour got lighter while they watched it darken.
  const direction = repair.amount < 0 ? 'deeper' : 'lighter';
  const opening = isSmallest ? 'The smallest change that makes this readable' : 'What this changes';

  return (
    `${opening}: a ${direction} shade of ${subject}, same hue, ` +
    `reaching ${repair.ratio.toFixed(1)}:1.`
  );
}

/**
 * Ask the adviser which side of each failing pair should move.
 *
 * Throws only when the agent is unseeded or no provider is configured — the caller treats that as
 * degraded rather than as a failed optimise, because the deterministic answer is genuinely usable.
 * An unparseable reply is NOT a throw: the structured runner has already retried, and a second
 * unparseable attempt means the same thing as no picks at all.
 */
export async function advise(input: AdviseInput): Promise<AdviseResult> {
  if (input.audited.length === 0) return { proposals: [], degraded: false };

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: BRAND_CONTRAST_AGENT_SLUG },
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
  if (!agent) throw new Error('Brand contrast adviser is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'chat');
  const provider = await getProvider(providerSlug);

  const result = await runStructuredCompletion<z.infer<typeof adviceSchema>>({
    provider,
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserMessage(input.audited) },
    ],
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, (parsed) => adviceSchema.safeParse(parsed).data ?? null),
    retryUserMessage:
      'Respond with ONLY the JSON object {"picks": [{"pair": "<id>", "repair": <number>, "why": ' +
      '"<one sentence>"}]} — no prose, no code fence.',
    responseSchema: RESPONSE_SCHEMA,
    responseSchemaName: 'contrast_advice',
    phase: 'brand-contrast',
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_brand_contrast',
    // Version-less for the same reason a brand import is: the theme belongs to a demo client, not
    // to any questionnaire version. The client rides in `extra` so the spend stays attributable.
    versionId: null,
    extra: { findings: input.audited.length, demoClientId: input.demoClientId },
  });

  return { proposals: applyPicks(input.audited, result.value.picks ?? []), degraded: false };
}

/**
 * Merge the model's picks into the audited findings.
 *
 * Exported for its own test: this function is the whole "the adviser cannot invent a colour"
 * guarantee, and a guarantee exercised only through a mocked provider is one nobody is checking.
 * Every pick is dropped unless it names a finding we actually raised and an index that exists in
 * that finding's own repair list — a pick for an unknown pair, a pick out of range, and a second
 * pick for a pair already decided all fall back to the deterministic recommendation.
 */
export function applyPicks(
  audited: AuditedPair[],
  picks: { pair: string; repair: number; why: string }[]
): ContrastProposal[] {
  const decided = new Map<string, { repair: number; why: string }>();
  for (const pick of picks) {
    if (decided.has(pick.pair)) continue;
    decided.set(pick.pair, pick);
  }

  return audited.map((pair) => {
    const pick = decided.get(pair.finding.pair);
    if (!pick) return recommendDefault(pair);

    // The index is the only thing the model controls that touches a colour, so it is the only
    // thing that has to be range-checked. Out of range is a fabrication, not a typo: there is no
    // "nearest valid index" that means anything, so the deterministic pick stands.
    if (!Number.isInteger(pick.repair) || pick.repair < 0 || pick.repair >= pair.repairs.length) {
      logger.info('Brand contrast: adviser chose a repair that does not exist', {
        pair: pair.finding.pair,
        repair: pick.repair,
        offered: pair.repairs.length,
      });
      return recommendDefault(pair);
    }

    const why = pick.why.trim();
    return {
      finding: pair.finding,
      repairs: pair.repairs,
      chosen: pick.repair,
      // An empty rationale is described rather than left blank: the sentence IS the advice, and a
      // proposal with none is worse than one that at least says what it does. The description
      // follows the CHOSEN repair, so it can never narrate a change the proposal is not making.
      rationale:
        why.length > 0
          ? why.slice(0, RATIONALE_MAX)
          : describeRepair(pair.repairs[pick.repair], pick.repair === 0),
    };
  });
}

const SYSTEM = joinSections(
  'You advise on brand colour. A questionnaire has been branded with a client’s colours, some of ' +
    'which cannot be read by a person with ordinary eyesight. The arithmetic is already done: for ' +
    'each problem you are given the fixes that WOULD work, each one a shade of a colour already in ' +
    'the brand, with its hue and saturation untouched. Your job is to choose between them.',
  'How to choose:',
  bulletList([
    'Prefer moving the colour that carries the least brand identity. Text is usually less ' +
      'load-bearing than the ground it sits on; a derived value is less load-bearing than one the ' +
      'client specified.',
    'Prefer the smaller change when nothing else separates two fixes. The numbers beside each fix ' +
      'say how far it moves.',
    'A page ground is often what a brand is recognised BY — a cream paper stock, a deep navy ' +
      'field. Bleaching it to fix the text is usually the wrong trade.',
    'The button and the header band have no separate text colour to move: their label is chosen ' +
      'for them, so the only fix is the band or button colour itself.',
  ]),
  'How to write the reason:',
  bulletList([
    'One sentence, plain English, for someone who is not a designer.',
    'Say what is moving and why THAT rather than the alternative. Never quote a hex code — the ' +
      'admin is looking at the swatch.',
    'Never claim the change is invisible or that it preserves the brand exactly. It is a change, ' +
      'and the admin is the one deciding whether it is acceptable.',
  ])
);

/** The findings and their repairs, numbered — the list the model chooses an index from. */
function buildUserMessage(audited: AuditedPair[]): string {
  const problems = audited.map((pair) => {
    const { finding, repairs } = pair;
    const header =
      `${finding.pair} — ${finding.label}. Currently ${finding.ratio.toFixed(1)}:1, needs ` +
      `${finding.target}:1.` +
      (finding.onDerivedValue
        ? ' At least one of these two colours was not set by the admin — it is our default or one we derived.'
        : '');

    const options = repairs.map(
      (repair, index) =>
        `${index}: change ${repair.label}${repair.from ? '' : ' (currently unset)'} — ` +
        `${repair.amount < 0 ? 'darkens' : 'lightens'} it by ` +
        `${(Math.abs(repair.amount) * 100).toFixed(0)}%, ` +
        `reaching ${repair.ratio.toFixed(1)}:1`
    );

    return titledBlock(header, bulletList(options));
  });

  return joinSections(
    titledBlock('Problems, each with the fixes that would work', problems.join('\n\n')),
    'Return one pick per problem, using the problem id exactly as written and the number of the ' +
      'fix you choose from that problem’s own list.'
  );
}
