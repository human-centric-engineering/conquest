/**
 * The Scope Planner (P17) — "which parts of this questionnaire is this interview about?"
 *
 * Runs ONCE per session, the moment the opening topics are covered. Three tiers, in order:
 *
 *  1. **Hard rules** (`scope/rules.ts`) — the cases the author is certain about. Resolved before
 *     any model call, and never overridden by one.
 *  2. **This module's `askPlanner`** — a judgement over the author's criteria and what the
 *     respondent actually said.
 *  3. **Guardrails** (`scope/guardrails.ts`) — the cap, the blind-spot check, the fallback. Applied
 *     to whatever came back, so a model that ignores the limit cannot break it.
 *
 * `planScope` **never throws**. The respondent has just finished answering the opening and is
 * waiting; every failure mode — no agent configured, no provider, a timeout, unparseable JSON, a
 * hallucinated topic key, confidence below the floor — resolves to a plan rather than an exception.
 * A thin interview is recoverable; a spinner that never resolves is not.
 *
 * Deliberately modelled on `experiences/routing/select.ts`, down to the retry and the cost log. Two
 * decision-making surfaces in the same product that fail differently would be two things to learn.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import {
  MAX_ANSWERS_IN_PLANNER_PROMPT,
  MAX_FILLS_IN_PLANNER_PROMPT,
  PLANNER_ANSWER_CHARS,
  PLANNER_FILL_CHARS,
  SCOPE_PLANNER_AGENT_SLUG,
  SCOPE_PLANNER_MAX_TOKENS,
  SCOPE_PLANNER_TIMEOUT_MS,
} from '@/lib/app/questionnaire/scope/constants';
import { evaluateScopeRules, type ScopeFill } from '@/lib/app/questionnaire/scope/rules';
import {
  applyGuardrails,
  alwaysTopics,
  plannerCandidates,
  type PlanBudget,
  type ProposedTopic,
} from '@/lib/app/questionnaire/scope/guardrails';
import type {
  AdaptiveScopeSettings,
  InterviewPlan,
  Topic,
} from '@/lib/app/questionnaire/scope/types';

const plannerSchema = z.object({
  selected: z.array(z.object({ topicKey: z.string(), rationale: z.string() })),
  confidence: z.number(),
  respondentMessage: z.string(),
});

/**
 * One answered question, as the prompt reads it.
 *
 * The `prompt` is not decoration: an answer without the question it answers is not evidence. "About
 * two years" means nothing until you know it answered "how long has this been a problem?".
 */
export interface ScopeAnswer {
  /** The question's key. */
  key: string;
  /** What the question asked. */
  prompt: string;
  /** The stored answer — a mapped form value (a choice slug, a scale point) for typed questions. */
  value: unknown;
  /** The living natural-language account of what they conveyed, when the answer has one. */
  paraphrase: string | null;
}

export interface PlanScopeParams {
  sessionId: string;
  /** Every topic in the version. */
  topics: readonly Topic[];
  /** The data-slot fills — what the extractor captured from what the respondent said. */
  fills: readonly ScopeFill[];
  /**
   * The questions answered so far, in the respondent's own words, most relevant first.
   *
   * The primary evidence. `fills` are extractions FROM these words, not additional information —
   * and an instrument whose opening asks questions without data slots behind them produces no
   * fills at all, which used to leave the planner deciding on an empty prompt.
   */
  answers?: readonly ScopeAnswer[];
  /** An optional LLM-written summary of the opening, when the caller has one. */
  briefing?: string | null;
  /** The questionnaire's stated goal, for framing. */
  goal?: string | null;
  settings: AdaptiveScopeSettings;
  /** Turn ordinal the plan is being decided at. */
  decidedAtTurn: number;
  /**
   * The session time budget and what each topic costs (C7b), when the version sets one.
   *
   * Priced by the caller, which has the question types this module never loads. Absent means no
   * budget, which is the default: the plan is then bounded by the topic count alone, exactly as it
   * was before budgets existed.
   */
  budget?: PlanBudget;
}

/** The plan plus what producing it cost, so the caller can bill and audit it. */
export interface PlanScopeResult {
  plan: InterviewPlan;
  costUsd: number;
  provider: string | null;
  model: string | null;
  /** Raw prompt + output for the AppAiRun snapshot. Null when no model call was made. */
  promptSnapshot: string | null;
  outputSnapshot: unknown;
}

/** A readable rendering of a stored answer value, or null when there is nothing worth printing. */
function answerText(answer: ScopeAnswer): string | null {
  // Paraphrase first, always. It is the natural-language account of what they conveyed; `value`
  // holds the MAPPED form value for a typed question — a choice slug like `gt3` — and feeding form
  // codes to a model that is reading for meaning is noise at best.
  if (answer.paraphrase && answer.paraphrase.trim() !== '') return answer.paraphrase.trim();
  if (typeof answer.value === 'string' && answer.value.trim() !== '') return answer.value.trim();
  if (typeof answer.value === 'number' || typeof answer.value === 'boolean') {
    return String(answer.value);
  }
  if (Array.isArray(answer.value) && answer.value.length > 0) {
    return answer.value.map((v) => String(v)).join(', ');
  }
  return null;
}

function renderAnswers(answers: readonly ScopeAnswer[]): string[] {
  const lines: string[] = [];
  for (const answer of answers) {
    if (lines.length >= MAX_ANSWERS_IN_PLANNER_PROMPT) break;
    const text = answerText(answer);
    if (!text) continue;
    lines.push(`- Asked: ${answer.prompt}\n  Answered: ${text.slice(0, PLANNER_ANSWER_CHARS)}`);
  }
  return lines;
}

/**
 * The evidence block: what they said, then what was captured from it.
 *
 * Their own words come first because that is what they are — the primary record. A fill is an
 * extraction from those words, so it can be thin, stale, or simply absent, and a planner that reads
 * only fills is reading a summary of a conversation it was never shown.
 */
function renderConveyed(
  fills: readonly ScopeFill[],
  answers: readonly ScopeAnswer[],
  briefing: string | null | undefined
): string {
  const answerLines = renderAnswers(answers);
  const fillLines = fills.slice(0, MAX_FILLS_IN_PLANNER_PROMPT).map((f) => {
    const text =
      typeof f.value === 'string' && f.value.trim() !== ''
        ? f.value
        : (f.paraphrase ?? '(no answer captured)');
    return `- [${f.key}] ${text.slice(0, PLANNER_FILL_CHARS)}`;
  });

  const parts: string[] = [];
  if (answerLines.length > 0) parts.push(`In their own words:\n${answerLines.join('\n')}`);
  if (fillLines.length > 0) parts.push(`Captured from what they said:\n${fillLines.join('\n')}`);
  if (parts.length === 0) parts.push('(nothing was captured in the opening)');
  if (briefing) parts.push(`Summary of the conversation so far:\n${briefing}`);
  return parts.join('\n\n');
}

function renderCandidates(candidates: readonly Topic[]): string {
  return candidates
    .map((t) => {
      const lines = [`- key: ${t.key}`, `  name: ${t.label}`];
      if (t.criteria) lines.push(`  choose when: ${t.criteria}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Ask the planner. Returns null on any failure — the caller then falls back.
 *
 * Never throws: this is the one call standing between a respondent and the rest of their interview.
 */
async function askPlanner(params: PlanScopeParams, candidates: readonly Topic[]) {
  // Wrapped, not bare: `planScope` promises never to throw, and a database blip during the agent
  // lookup is no more the respondent's problem than a model timeout is. Both degrade to the
  // author's fallback plan.
  let agent: {
    id: string;
    provider: string;
    model: string;
    fallbackProviders: string[];
  } | null = null;
  try {
    agent = await prisma.aiAgent.findUnique({
      where: { slug: SCOPE_PLANNER_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
  } catch (err) {
    logger.error('scope planner: agent lookup failed; falling back', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!agent) {
    logger.warn('scope planner: agent not configured; falling back', {
      sessionId: params.sessionId,
    });
    return null;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('scope planner: no provider resolved; falling back', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const max = params.settings.maxConditionalTopics;
  const system = joinSections(
    section(
      'role',
      "You decide which parts of a questionnaire are worth a respondent's time. You have what they " +
        'said in the opening, and a set of candidate topics the author marked as conditional. Choose ' +
        'the ones that genuinely fit what this person conveyed.'
    ),
    section(
      'rules',
      joinSections(
        `Choose AT MOST ${max} topic${max === 1 ? '' : 's'}, best first. Fewer is a perfectly good ` +
          "answer — selecting a topic nothing in the opening points at wastes the respondent's time " +
          'and produces a score they did not need.',
        'Weigh each candidate against its "choose when" criteria first — that is the author\'s own ' +
          'account of when the topic is right, and it outranks your general judgement.',
        'Read for what the respondent MEANS, not the words they used. Someone describing deals that ' +
          '"go dark at procurement" has named a pipeline problem without using the word pipeline.',
        'What they said in their own words is the primary evidence. The captured items beneath it ' +
          'were extracted from those same words — they are a summary, not extra information — so ' +
          'where the two disagree, go with what the respondent actually said.',
        'A topic whose criteria require something the respondent did not supply is NOT a match, ' +
          'however much the surrounding subject seems related.',
        '`topicKey` MUST be one of the candidate keys exactly. Never invent one.',
        'Report `confidence` honestly as 0–1. A low score is useful — it routes the decision to a ' +
          'safe default rather than acting on a guess. Do not inflate it.',
        '`rationale` is for the administrator: one sentence naming the specific thing in the ' +
          'opening that drove this choice.',
        '`respondentMessage` is spoken to the respondent before the chosen topics run: one or two ' +
          'warm, plain sentences naming the areas you want to go deeper on, in their language. ' +
          'Never mention keys, scores, confidence, criteria, or that a decision was made about them.'
      )
    ),
    section(
      'what_the_respondent_conveyed',
      renderConveyed(params.fills, params.answers ?? [], params.briefing)
    ),
    section('candidate_topics', renderCandidates(candidates)),
    ...(params.goal ? [section('questionnaire_goal', params.goal)] : []),
    ...(params.settings.plannerInstructions
      ? [section('additional_guidance_from_the_administrator', params.settings.plannerInstructions)]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"selected":[{"topicKey":string,"rationale":string}],' +
        '"confidence":number,"respondentMessage":string}. No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof plannerSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Choose the topics now, as JSON.' },
      ],
      maxTokens: SCOPE_PLANNER_MAX_TOKENS,
      timeoutMs: SCOPE_PLANNER_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = plannerSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"selected":[{"topicKey":string,' +
        '"rationale":string}],"confidence":number,"respondentMessage":string}.',
      onFinalFailure: () => new Error('Planner response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_scope_planning', sessionId: params.sessionId },
    }).catch((err: unknown) => {
      // Best-effort, but a silent swallow would hide a systematic cost-logging outage.
      logger.error('scope planner: logCost rejected', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      value: completion.value,
      costUsd: completion.costUsd ?? 0,
      provider: providerSlug,
      model,
      prompt: system,
    };
  } catch (err) {
    logger.warn('scope planner: call failed; falling back', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Produce the interview plan. Never throws.
 *
 * Skips the model entirely when there is nothing to decide — no conditional topics, or every one
 * already settled by a rule — because paying for a foregone conclusion is waste and the latency
 * lands on someone who is waiting.
 */
export async function planScope(params: PlanScopeParams): Promise<PlanScopeResult> {
  const noCall = {
    costUsd: 0,
    provider: null,
    model: null,
    promptSnapshot: null,
    outputSnapshot: null,
  };
  const decidedAt = new Date().toISOString();

  const validKeys = params.topics.map((t) => t.key);
  const rules = evaluateScopeRules(params.settings.rules, params.fills, validKeys);
  const candidates = plannerCandidates(params.topics, rules);

  const base = {
    topics: params.topics,
    rules,
    settings: params.settings,
    decidedAtTurn: params.decidedAtTurn,
    decidedAt,
    // Carried on EVERY path, including the ones that never call a model: a fallback plan is still
    // an interview someone has to sit through, and a rule-only plan is the one most likely to be
    // long. A budget that applied only to the model's picks would be a budget with a hole in it.
    budget: params.budget,
  };

  // Nothing to choose between: the rules (or the absence of candidates) already settled it.
  if (candidates.length === 0) {
    return {
      plan: applyGuardrails({
        ...base,
        proposed: [],
        confidence: 1,
        source: 'llm',
        respondentMessage: '',
      }),
      ...noCall,
    };
  }

  const asked = await askPlanner(params, candidates);
  if (!asked) {
    return {
      plan: applyGuardrails({
        ...base,
        proposed: [],
        confidence: 0,
        source: 'fallback',
        respondentMessage: '',
      }),
      ...noCall,
    };
  }

  const withCall = {
    costUsd: asked.costUsd,
    provider: asked.provider,
    model: asked.model,
    promptSnapshot: asked.prompt,
    outputSnapshot: asked.value,
  };

  // Clamp rather than reject: a model reporting 1.2 means "very confident", and discarding an
  // otherwise-good plan over a malformed scalar would be perverse.
  const confidence = Number.isFinite(asked.value.confidence)
    ? Math.min(1, Math.max(0, asked.value.confidence))
    : 0;

  if (confidence < params.settings.minConfidence) {
    logger.info('scope planner: below the confidence floor; using the fallback', {
      sessionId: params.sessionId,
      confidence,
      floor: params.settings.minConfidence,
    });
    return {
      plan: applyGuardrails({
        ...base,
        proposed: [],
        confidence,
        source: 'fallback',
        // The model's message described topics the fallback may not have chosen, so it would be a
        // lie to the respondent. Better silence than a warm sentence about the wrong thing.
        respondentMessage: '',
      }),
      ...withCall,
    };
  }

  const proposed: ProposedTopic[] = asked.value.selected.map((s) => ({
    key: s.topicKey,
    rationale: s.rationale,
  }));

  return {
    plan: applyGuardrails({
      ...base,
      proposed,
      confidence,
      source: 'llm',
      respondentMessage: asked.value.respondentMessage,
    }),
    ...withCall,
  };
}

/** What the caller knows about the session's question answers, for the opening gate. */
export interface OpeningQuestionCoverage {
  /** Question keys this session already holds an answer for. */
  answered: ReadonlySet<string>;
  /**
   * Every question key the version actually has.
   *
   * An opening topic may name a key that no longer resolves — a question deleted after the topic
   * was authored — and that key can never be answered. Unresolvable member keys are silently
   * skipped everywhere else in this feature; skipping them here too is what stops a stale member
   * from holding every interview in its opening forever.
   */
  known: ReadonlySet<string>;
}

/**
 * Whether the opening is complete enough to plan — every opening topic's members are covered.
 *
 * Both kinds of member count. Judging the opening on its data slots alone made an opening topic
 * built only from questions complete before it had been asked, so the planner ran on the first turn
 * with nothing captured: a judgement over an empty transcript, and — worse — every `not_exists`
 * hard rule matching, because absence is exactly what a veto tests for. A veto meant for a few
 * respondents applied to all of them, in a plan that looks entirely plausible.
 *
 * `questions` is optional so a caller that genuinely has no answer data still gets the data-slot
 * gate rather than nothing. The direction on everything unjudgeable stays as it was: planning
 * slightly early costs a less-informed plan, while never planning strands the interview in its
 * opening forever.
 */
export function isOpeningComplete(
  topics: readonly Topic[],
  filledDataSlotKeys: ReadonlySet<string>,
  questions?: OpeningQuestionCoverage
): boolean {
  const opening = alwaysTopics(topics).filter((t) => t.phase === 'opening');
  if (opening.length === 0) return true;

  const requiredSlots = opening.flatMap((t) => t.members.dataSlotKeys);
  if (!requiredSlots.every((key) => filledDataSlotKeys.has(key))) return false;

  if (questions) {
    const requiredQuestions = opening
      .flatMap((t) => t.members.questionKeys)
      .filter((key) => questions.known.has(key));
    if (!requiredQuestions.every((key) => questions.answered.has(key))) return false;
  }

  return true;
}
