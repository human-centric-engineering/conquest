/**
 * Opening-question suggestions — read a questionnaire, propose openers for it.
 *
 * The sibling of `house-rules/suggest.ts`, and structurally identical: a **one-shot analyst**, not a
 * chat, that **persists nothing**. The route returns candidates, the admin accepts the ones they
 * want into the editor, and the ordinary config PATCH saves them (audited like any other settings
 * change). There is deliberately no apply endpoint.
 *
 * What differs is the subject. An opener is not a rule — it is the single most consequential turn in
 * the conversation, because it decides whether someone writes three words or three paragraphs. So
 * the prompt is built around one job: propose questions that are **broad enough to ramble at** and
 * **recognisably about this questionnaire**, which is the pairing an admin cannot get from a generic
 * library of openers.
 *
 * Four prompt decisions carry most of the quality:
 *   - It is told the openers are used as GUIDANCE, not read out. Without that it writes safe,
 *     ready-to-recite questions; told the interviewer will riff on them, it writes better models.
 *   - It is told to anchor on the questionnaire's SUBJECT, not its individual questions — an opener
 *     that names one question defeats the purpose of opening broadly.
 *   - It is told what makes an opener fail (leading, yes/no-able, jargon, double-barrelled), because
 *     those are the failure modes that survive a plausible-looking first draft.
 *   - It is told to VARY the openers it proposes, so the admin gets a genuine choice of registers
 *     rather than one question rephrased five ways.
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
import { QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { OPENING_EXAMPLE_MAX } from '@/lib/app/questionnaire/types';

/** How many candidates to ask for. A choice of registers, not a catalogue. */
const TARGET_MIN = 3;
const TARGET_MAX = 5;
/** Hard ceiling on what we hand back, whatever the model returns. */
const MAX_SUGGESTIONS = 6;
/**
 * Questions sampled into the prompt. Enough to characterise the subject, not the whole instrument.
 * Exported so the route caps its query with the SAME number — two constants applying the same limit
 * at two layers means changing one silently does nothing.
 */
export const MAX_QUESTIONS_IN_PROMPT = 40;
/** Section titles sampled in. They map the territory an opener has to be broad enough to cover. */
export const MAX_SECTIONS_IN_PROMPT = 15;
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 45_000;
/** Bound on the `why` line so one verbose suggestion can't dominate the panel. */
const WHY_MAX_LENGTH = 200;

/** What the assistant needs to know about the version it is proposing openers for. */
export interface OpeningExamplesSuggestContext {
  title: string;
  goal: string;
  audience?: {
    role?: string;
    expertiseLevel?: string;
    sensitivity?: string;
  };
  /** Section titles — the shape of the territory, which an opener must be wide enough to cover. */
  sectionTitles: string[];
  /** Question prompts, already capped by the caller or here. */
  questions: string[];
  /** Defined terms, so an opener can use the client's own vocabulary — or deliberately avoid it. */
  glossaryTerms: string[];
  /** The subject is sensitive, so the opening has to earn its way in gently. */
  sensitivityAwareness: boolean;
  /** Openers already written, so it proposes alternatives rather than restatements. */
  existingExamples: ReadonlyArray<string>;
}

/** One proposed opener. `why` is the decision support, and is never stored on the example itself. */
export interface OpeningExampleSuggestion {
  text: string;
  why: string;
}

export interface OpeningExamplesSuggestResult {
  suggestions: OpeningExampleSuggestion[];
}

function trimTo(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Narrow the model's reply. Drops anything unusable rather than failing the whole call: three good
 * openers with one malformed fourth is still a useful answer.
 *
 * The cap is {@link OPENING_EXAMPLE_MAX} — the same bound the Zod schema and the editor enforce — so
 * the assistant can never propose something the save would reject. Duplicates are dropped too: two
 * identical openers in the list would look like a UI bug rather than a model quirk.
 *
 * Returns `null` only when the envelope itself is wrong — that is what earns a retry.
 */
export function validateSuggestResult(parsed: unknown): OpeningExamplesSuggestResult | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.suggestions)) return null;

  const suggestions: OpeningExampleSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.suggestions) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (!isRecord(raw)) continue;

    const text = trimTo(raw.text, OPENING_EXAMPLE_MAX);
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    suggestions.push({ text, why: trimTo(raw.why, WHY_MAX_LENGTH) });
  }

  return { suggestions };
}

/** Compose the one-shot analysis prompt. Pure — unit-tested without a provider. */
export function buildSuggestMessages(context: OpeningExamplesSuggestContext): LlmMessage[] {
  const system = joinSections(
    section(
      'role',
      'You advise on how a conversational questionnaire should OPEN. Given one questionnaire, ' +
        'propose a few example opening questions — the very first thing the interviewer asks, ' +
        'before any specific question comes up.'
    ),
    section(
      'how_your_examples_are_used',
      'Your examples are shown to the interviewer as GUIDANCE, not as a script. It is explicitly ' +
        'told to match their breadth, register and the kind of thinking they invite, and then to ' +
        'write its OWN opener in the same vein — never to read one out. So write them as strong ' +
        'MODELS of a register rather than as polished lines to be recited, and do not worry about ' +
        'covering every case: three good models teach more than ten near-duplicates. The admin ' +
        'will also read and edit them, so they must stand up as plain English.'
    ),
    section(
      'what_makes_a_good_opener',
      joinSections(
        'A good opening question is:',
        bulletList([
          'BROAD — about the questionnaire’s subject as a whole, not any one of its questions. A ' +
            'single wide answer should be able to touch several topics at once.',
          'EASY — answerable immediately by anyone in the audience, with no preparation, no ' +
            'homework and no need to have an opinion ready.',
          'OPEN — impossible to answer with yes, no, or a number. It must invite a story, an ' +
            'experience or a reflection.',
          'NEUTRAL — it must not suggest what a good answer looks like, imply the expected ' +
            'sentiment, or presume the respondent’s view.',
          'SINGLE — one question. Not two joined by "and", and not a question with a second ' +
            'question tacked on as a clarification.',
          'PLAIN — the respondent’s own words, not the client’s internal jargon or the ' +
            'questionnaire’s framing of itself.',
        ])
      )
    ),
    section(
      'rules',
      joinSections(
        `Propose between ${TARGET_MIN} and ${TARGET_MAX} openers. Fewer is better than padding.`,
        'VARY them. Each should offer a genuinely different way in — for example: an invitation to ' +
          'describe an overall experience; a story or a specific moment; a reflection on what comes ' +
          'to mind; a blank-page or "if you could say one thing" framing; or an appreciative-and-' +
          'critical "what stands out, good and bad". Five rephrasings of one question is a failure.',
        'Anchor every opener on the SUBJECT of this questionnaire, so it is unmistakably about ' +
          'this one and not a generic opener that would suit any questionnaire. But do NOT name, ' +
          'quote or paraphrase an individual question from the list — the opening deliberately ' +
          'comes before any of them.',
        'Keep each opener to one or two sentences.',
        'Give every opener a short `why` — one sentence on what it is good for and who it suits. ' +
          'This is the most useful part of your answer: the admin is choosing, not you.',
        'Do NOT restate an opener the questionnaire already has. Propose alternatives only.',
        'Do NOT write anything about how the answers are used, who sees them, how long it takes, ' +
          'or that a questionnaire is being completed in the background — the interviewer handles ' +
          'all of that separately, and an opener that does it too says it twice.'
      )
    ),
    section(
      'output_format',
      'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
        '{"suggestions": [{"text": string, "why": string}]}\n' +
        'If you have nothing worth proposing, return an empty array.'
    )
  );

  const a = context.audience ?? {};
  const notes: string[] = [];
  if (context.sensitivityAwareness) {
    notes.push(
      'This questionnaire covers sensitive ground. The opening must be gentle and unpressured, ' +
        'and must not lead with the difficult part — let the respondent choose how far in to go.'
    );
  }
  if (a.expertiseLevel) {
    notes.push(
      `Pitch the language for this audience’s expertise (${a.expertiseLevel}) — never above it.`
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
    context.sectionTitles.length > 0
      ? titledBlock(
          'The ground it covers',
          bulletList(context.sectionTitles.slice(0, MAX_SECTIONS_IN_PROMPT))
        )
      : '',
    context.questions.length > 0
      ? titledBlock(
          'What it asks about (for your understanding of the subject — do not ask any of these)',
          bulletList(context.questions.slice(0, MAX_QUESTIONS_IN_PROMPT))
        )
      : '',
    context.glossaryTerms.length > 0
      ? titledBlock('Terms this questionnaire defines', bulletList(context.glossaryTerms))
      : '',
    notes.length > 0 ? titledBlock('Things to bear in mind', bulletList(notes)) : '',
    context.existingExamples.length > 0
      ? titledBlock(
          'Openers it already has (do not restate these)',
          bulletList([...context.existingExamples])
        )
      : '',
    'Propose the opening questions now.'
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
export async function suggestOpeningExamples(opts: {
  context: OpeningExamplesSuggestContext;
  versionId: string;
}): Promise<OpeningExamplesSuggestResult & { costUsd: number; provider: string; model: string }> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_OPENING_EXAMPLES_AGENT_SLUG },
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
  if (!agent) throw new Error('Opening questions assistant is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  const result = await runStructuredCompletion<OpeningExamplesSuggestResult>({
    provider,
    model,
    messages: buildSuggestMessages(opts.context),
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, validateSuggestResult),
    retryUserMessage:
      'Respond with ONLY the JSON object {"suggestions": [{"text", "why"}]} — no prose, no code ' +
      'fence.',
    onFinalFailure: () =>
      new Error('Opening questions assistant response was not valid JSON after retry'),
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_opening_examples_suggest',
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
