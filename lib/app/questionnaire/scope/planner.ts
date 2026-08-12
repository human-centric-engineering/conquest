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
  MAX_FILLS_IN_PLANNER_PROMPT,
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

export interface PlanScopeParams {
  sessionId: string;
  /** Every topic in the version. */
  topics: readonly Topic[];
  /** The opening data-slot fills — what the respondent actually conveyed. */
  fills: readonly ScopeFill[];
  /** An optional LLM-written summary of the opening, when the caller has one. */
  briefing?: string | null;
  /** The questionnaire's stated goal, for framing. */
  goal?: string | null;
  settings: AdaptiveScopeSettings;
  /** Turn ordinal the plan is being decided at. */
  decidedAtTurn: number;
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

function renderFills(fills: readonly ScopeFill[], briefing: string | null | undefined): string {
  const lines = fills.slice(0, MAX_FILLS_IN_PLANNER_PROMPT).map((f) => {
    const text =
      typeof f.value === 'string' && f.value.trim() !== ''
        ? f.value
        : (f.paraphrase ?? '(no answer captured)');
    return `- [${f.key}] ${text.slice(0, PLANNER_FILL_CHARS)}`;
  });

  const parts = [lines.join('\n') || '(nothing was captured in the opening)'];
  if (briefing) parts.push(`\nSummary of the conversation so far:\n${briefing}`);
  return parts.join('\n');
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
    section('what_the_respondent_conveyed', renderFills(params.fills, params.briefing)),
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

/** Whether the opening is complete enough to plan — every always-run opening topic is covered. */
export function isOpeningComplete(
  topics: readonly Topic[],
  filledDataSlotKeys: ReadonlySet<string>
): boolean {
  const opening = alwaysTopics(topics).filter((t) => t.phase === 'opening');
  if (opening.length === 0) return true;

  const required = opening.flatMap((t) => t.members.dataSlotKeys);
  // An opening topic built only from question slots (no data slots) cannot be judged this way; the
  // caller's question-coverage check governs there. Returning true is the safe direction — planning
  // slightly early costs a less-informed plan, while never planning strands the interview in its
  // opening forever.
  if (required.length === 0) return true;

  return required.every((key) => filledDataSlotKeys.has(key));
}
