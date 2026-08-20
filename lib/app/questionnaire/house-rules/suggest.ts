/**
 * House-rule suggestions — read a questionnaire, propose behaviour rules for it.
 *
 * The last and largest piece of this feature's decision support. The starter library
 * (`presets.ts`) answers "what kinds of rule exist"; this answers "what would this *particular*
 * questionnaire want" — it reads the goal, audience, the questions themselves, the glossary, and the
 * settings that interact with rules, and proposes a handful with a reason for each.
 *
 * A **one-shot analyst**, not a chat: one call in, a set of candidates out. That shape is deliberate
 * and is why it follows the Config Advisor's precedent rather than the Respondent Report config
 * assistant's — see `recordAiRun`'s `house_rules_suggest` kind for the provenance argument.
 *
 * **Persists nothing.** The route returns candidates, the admin accepts the ones they want into the
 * editor, and the ordinary config PATCH saves them (audited like any other settings change). There
 * is deliberately no apply endpoint: a rule the admin has not read is exactly what this feature
 * exists to prevent.
 *
 * Three prompt decisions carry most of the quality:
 *   - It is told what it CANNOT usefully propose (scoring, question order, reply format), mirroring
 *     the authoring lints — a suggester that trips the linter on its own output is worse than none.
 *   - It is given the rules already present and told not to restate them.
 *   - It is told to prefer proposing nothing over padding, because a long generic list is how an
 *     admin learns to stop reading suggestions.
 */

import { prisma } from '@/lib/db/client';
import { isRecord } from '@/lib/utils';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import {
  bulletList,
  joinSections,
  section,
  titledBlock,
} from '@/lib/app/questionnaire/prompt/format';
import { QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import {
  HOUSE_RULE_CATEGORIES,
  HOUSE_RULE_CATEGORY_BLURBS,
  HOUSE_RULE_CATEGORY_LABELS,
} from '@/lib/app/questionnaire/house-rules/presets';
import {
  HOUSE_RULE_KINDS,
  HOUSE_RULE_TEXT_MAX,
  HOUSE_RULE_TRIGGER_MAX,
  type HouseRule,
  type HouseRuleKind,
} from '@/lib/app/questionnaire/types';

/** How many candidates to ask for. Small on purpose — see the module note on padding. */
const TARGET_MIN = 4;
const TARGET_MAX = 8;
/** Hard ceiling on what we hand back, whatever the model returns. */
const MAX_SUGGESTIONS = 10;
/**
 * Questions sampled into the prompt. Enough to characterise the instrument, not the whole thing.
 * Exported so the route can cap its query with the SAME number — two independent constants applying
 * the same limit at two layers means changing one silently does nothing.
 */
export const MAX_QUESTIONS_IN_PROMPT = 40;
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 45_000;
/** Bound on the `why` line so one verbose suggestion can't dominate the panel. */
const WHY_MAX_LENGTH = 240;

/** What the assistant needs to know about the version it is proposing rules for. */
export interface HouseRulesSuggestContext {
  title: string;
  goal: string;
  audience?: {
    role?: string;
    expertiseLevel?: string;
    sensitivity?: string;
  };
  /** Question prompts, already capped by the caller or here. */
  questions: string[];
  /** Defined terms in play, so a terminology rule can use the version's own vocabulary. */
  glossaryTerms: string[];
  /** Settings a rule can contradict — the assistant is told about them so it doesn't. */
  anonymousMode: boolean;
  sensitivityAwareness: boolean;
  hasSupportMessage: boolean;
  /** Rules already configured, so it proposes additions rather than restatements. */
  existingRules: ReadonlyArray<Pick<HouseRule, 'kind' | 'text'>>;
}

/** One proposed rule. `why` is the decision support, and is never stored on the rule itself. */
export interface HouseRuleSuggestion {
  kind: HouseRuleKind;
  text: string;
  trigger?: string;
  why: string;
}

export interface HouseRulesSuggestResult {
  suggestions: HouseRuleSuggestion[];
}

function isHouseRuleKind(value: unknown): value is HouseRuleKind {
  return typeof value === 'string' && (HOUSE_RULE_KINDS as readonly string[]).includes(value);
}

function trimTo(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Narrow the model's reply. Drops anything unusable rather than failing the whole call: a set of
 * four good suggestions with one malformed fifth is still a useful answer, and re-prompting the
 * admin because one entry was wrong would be the wrong trade.
 *
 * Returns `null` only when the envelope itself is wrong — that is what earns a retry.
 */
export function validateSuggestResult(parsed: unknown): HouseRulesSuggestResult | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.suggestions)) return null;

  const suggestions: HouseRuleSuggestion[] = [];
  for (const raw of parsed.suggestions) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (!isRecord(raw) || !isHouseRuleKind(raw.kind)) continue;

    const text = trimTo(raw.text, HOUSE_RULE_TEXT_MAX);
    if (!text) continue;

    const trigger = trimTo(raw.trigger, HOUSE_RULE_TRIGGER_MAX);
    // Same invariant the editor, the Zod schema, and the read-path narrower all hold: a trigger
    // belongs to `if_asked` and to nothing else. A suggestion that breaks it would fail the save.
    if (raw.kind === 'if_asked' && !trigger) continue;

    suggestions.push({
      kind: raw.kind,
      text,
      ...(raw.kind === 'if_asked' ? { trigger } : {}),
      why: trimTo(raw.why, WHY_MAX_LENGTH),
    });
  }

  return { suggestions };
}

/** Compose the one-shot analysis prompt. Pure — unit-tested without a provider. */
export function buildSuggestMessages(context: HouseRulesSuggestContext): LlmMessage[] {
  const categories = HOUSE_RULE_CATEGORIES.map(
    (key) => `${HOUSE_RULE_CATEGORY_LABELS[key]} — ${HOUSE_RULE_CATEGORY_BLURBS[key]}`
  );

  const system = joinSections(
    section(
      'role',
      'You advise on how a conversational questionnaire’s interviewer should behave. Given one ' +
        'questionnaire, propose a small set of house rules tailored to it: things the interviewer ' +
        'must ALWAYS do, must NEVER do, or should say IF a respondent asks about something.'
    ),
    section(
      'rules',
      joinSections(
        `Propose between ${TARGET_MIN} and ${TARGET_MAX} rules. Fewer is better than padding — ` +
          'propose only rules that genuinely fit THIS questionnaire, and say nothing for a category ' +
          'that has nothing worth adding. A long generic list is worse than three sharp rules.',
        'Each rule must be ONE checkable instruction describing observable behaviour. Not a mood, ' +
          'not two instructions joined by "and".',
        'Write each rule as the instruction itself, with no leading "Always"/"Never" — the kind ' +
          'already says that. For an "if_asked" rule, `trigger` is what the respondent raises (in ' +
          'plain words, e.g. "who will see their answers") and `text` is the substance of the reply.',
        'Give every rule a short `why` — one sentence telling the admin when this rule earns its ' +
          'place. This is the most useful part of your answer: the admin is deciding, not you.',
        'NEVER propose a rule about anything the interviewer does not control: scoring or marking ' +
          'answers, which questions get asked or in what order, skipping questions, what goes in ' +
          'the report, or the reply format (bullet points, headings, JSON). Those are set elsewhere ' +
          'and a rule about them silently does nothing.',
        'NEVER propose a rule that would have the interviewer ask more than one question in a turn.',
        'Do NOT restate a rule the questionnaire already has. Propose additions only.'
      )
    ),
    section(
      'kinds_of_rule',
      joinSections(
        'The situations house rules usually cover — use them to check for gaps, not as a list to ' +
          'fill in:',
        bulletList(categories)
      )
    ),
    section(
      'output_format',
      'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
        '{"suggestions": [{"kind": "always" | "never" | "if_asked", "text": string, ' +
        '"trigger"?: string, "why": string}]}\n' +
        'Include `trigger` for, and only for, an "if_asked" rule. If you have nothing worth ' +
        'proposing, return an empty array.'
    )
  );

  const a = context.audience ?? {};
  const constraints: string[] = [];
  // The assistant is told about the settings a rule could contradict, so it proposes something
  // compatible rather than something the authoring lints will immediately flag.
  constraints.push(
    context.anonymousMode
      ? 'This questionnaire is ANONYMOUS — responses are never linked to a person. Do not propose ' +
          'anything that asks for a name, email, or other identifying detail.'
      : 'This questionnaire is NOT anonymous — answers are linked to the respondent. Do not propose ' +
          'a rule that tells respondents their answers are anonymous, confidential, or untraceable.'
  );
  if (!context.sensitivityAwareness || !context.hasSupportMessage) {
    constraints.push(
      'No support signposting is active for this questionnaire, so do not propose a rule that ' +
        'points respondents at a support line or helpline — there is nothing for it to point to.'
    );
  }

  const user = joinSections(
    titledBlock('Questionnaire', context.title),
    context.goal ? titledBlock('Its goal', context.goal) : '',
    a.role || a.expertiseLevel || a.sensitivity
      ? titledBlock(
          'Who answers it',
          bulletList([
            a.role ? `Role: ${a.role}` : '',
            a.expertiseLevel ? `Expertise: ${a.expertiseLevel}` : '',
            a.sensitivity ? `Sensitivity of the subject: ${a.sensitivity}` : '',
          ])
        )
      : '',
    context.questions.length > 0
      ? titledBlock(
          'What it asks about',
          bulletList(context.questions.slice(0, MAX_QUESTIONS_IN_PROMPT))
        )
      : '',
    context.glossaryTerms.length > 0
      ? titledBlock('Terms this questionnaire defines', bulletList(context.glossaryTerms))
      : '',
    titledBlock('Settings you must not contradict', bulletList(constraints)),
    context.existingRules.length > 0
      ? titledBlock(
          'Rules it already has (do not restate these)',
          bulletList(context.existingRules.map((rule) => `[${rule.kind}] ${rule.text}`))
        )
      : '',
    'Propose the house rules now.'
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Run one suggestion pass. Throws when the assistant agent is unseeded, no provider is configured,
 * or the reply is unparseable after the runner's retry — the route maps those to a 502.
 */
export async function suggestHouseRules(opts: {
  context: HouseRulesSuggestContext;
  versionId: string;
}): Promise<HouseRulesSuggestResult & { costUsd: number; provider: string; model: string }> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_HOUSE_RULES_AGENT_SLUG },
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
  if (!agent) throw new Error('House rules assistant is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  const result = await runStructuredCompletion<HouseRulesSuggestResult>({
    provider,
    model,
    messages: buildSuggestMessages(opts.context),
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, validateSuggestResult),
    retryUserMessage:
      'Respond with ONLY the JSON object {"suggestions": [{"kind", "text", "trigger"?, "why"}]} — ' +
      'no prose, no code fence.',
    onFinalFailure: () =>
      new Error('House rules assistant response was not valid JSON after retry'),
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_house_rules_suggest',
    versionId: opts.versionId,
    extra: { suggestions: result.value.suggestions.length },
  });

  return {
    suggestions: result.value.suggestions,
    costUsd: result.costUsd,
    provider: providerSlug,
    model,
  };
}
