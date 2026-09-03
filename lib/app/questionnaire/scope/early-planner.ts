/**
 * The early-seating judgement (F17.36) — "is anything already unmistakable?"
 *
 * A sibling of `planner.ts`, deliberately modelled on it down to the failure discipline: the same
 * agent, the same timeout, the same never-throws contract, the same cost log. Two decision-making
 * surfaces in the same product that failed differently would be two things to learn.
 *
 * ## Why it is not just `planScope` called earlier
 *
 * Three things differ, and all three are in the prompt rather than the plumbing:
 *
 * 1. **The opening is not finished.** The full planner reads a complete opening and produces the
 *    interview. This reads a partial one and answers a much narrower question: is anything
 *    ALREADY beyond doubt?
 * 2. **Silence is the correct answer, most of the time.** The full planner choosing nothing is a
 *    thin interview. This choosing nothing costs the respondent nothing at all, because the full
 *    planner runs afterwards regardless, with more evidence. So the default is empty and the
 *    prompt says so plainly.
 * 3. **It cannot decline.** Nothing here excludes a topic, ranks one below another, or removes
 *    anything from scope. The only output is "these are already clear", and the trigger discards
 *    everything under the confidence bar.
 *
 * It returns judgements, not a plan. `applyEarlyJudgements` turns them into the session record and
 * the final `applyGuardrails` absorbs them at seal time.
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
  SCOPE_PLANNER_AGENT_SLUG,
  SCOPE_PLANNER_TIMEOUT_MS,
  SCOPE_PLANNER_MAX_TOKENS,
} from '@/lib/app/questionnaire/scope/constants';
import type { EarlyJudgement } from '@/lib/app/questionnaire/scope/early-seating';
import type { ScopeAnswer } from '@/lib/app/questionnaire/scope/planner';
import { renderConveyed, renderCandidates } from '@/lib/app/questionnaire/scope/planner-prompt';
import type {
  ConditionalTopicsSettings,
  ScopeFill,
  Topic,
} from '@/lib/app/questionnaire/scope/types';

const earlySchema = z.object({
  clear: z.array(
    z.object({
      topicKey: z.string(),
      confidence: z.number(),
      rationale: z.string(),
      respondentReason: z.string(),
    })
  ),
});

export interface JudgeEarlySeatingParams {
  sessionId: string;
  /** Conditional topics not already seated — what the model may name. Never empty. */
  candidates: readonly Topic[];
  fills: readonly ScopeFill[];
  answers: readonly ScopeAnswer[];
  goal: string | null;
  settings: ConditionalTopicsSettings;
  /** How much of the opening is in, as a percentage — the model is told, plainly. */
  coveragePct: number;
  /** The most this turn may seat, so the prompt does not invite a list nothing can take. */
  maxThisTurn: number;
}

export interface JudgeEarlySeatingResult {
  judgements: EarlyJudgement[];
  costUsd: number;
  provider: string | null;
  model: string | null;
  promptSnapshot: string | null;
  outputSnapshot: unknown;
}

/** Nothing judged, nothing spent — every failure path resolves to this. */
const NOTHING: JudgeEarlySeatingResult = {
  judgements: [],
  costUsd: 0,
  provider: null,
  model: null,
  promptSnapshot: null,
  outputSnapshot: null,
};

/**
 * Ask whether anything in the opening so far is already beyond doubt. Never throws.
 *
 * Every failure — no agent, no provider, a timeout, unparseable JSON — resolves to no judgements,
 * which leaves the session exactly as it was. That is the same outcome as the feature being off,
 * and the respondent never learns anything happened.
 */
export async function judgeEarlySeating(
  params: JudgeEarlySeatingParams
): Promise<JudgeEarlySeatingResult> {
  let agent: { id: string; provider: string; model: string; fallbackProviders: string[] } | null =
    null;
  try {
    agent = await prisma.aiAgent.findUnique({
      where: { slug: SCOPE_PLANNER_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
  } catch (err) {
    logger.error('early seating: agent lookup failed; seating nothing', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING;
  }
  if (!agent) {
    logger.warn('early seating: agent not configured; seating nothing', {
      sessionId: params.sessionId,
    });
    return NOTHING;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('early seating: no provider resolved; seating nothing', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING;
  }

  const max = params.maxThisTurn;
  const system = joinSections(
    section(
      'role',
      'You are reading an interview that is STILL IN ITS OPENING. Your only question is whether ' +
        'anything the respondent has already said makes one of the candidate areas unmistakably ' +
        'worth covering — clearly enough to start on it now, rather than waiting for the rest of ' +
        'the opening.'
    ),
    section(
      'rules',
      joinSections(
        `The opening is about ${params.coveragePct}% answered. You are seeing part of a ` +
          'conversation, not all of it.',
        'NAMING NOTHING IS THE NORMAL AND CORRECT ANSWER. The full decision is made at the end of ' +
          'the opening regardless, with everything the respondent has said by then. Nothing is ' +
          'lost by staying silent here, and an area named on thin evidence costs the respondent ' +
          'real time on questions they did not need.',
        `Name AT MOST ${max} area${max === 1 ? '' : 's'}, best first, and only where the evidence ` +
          'is already beyond argument.',
        'Weigh each candidate against its "choose when" criteria first — that is the author\'s own ' +
          'account of when the area is right, and it outranks your general judgement.',
        'A candidate whose criteria require something the respondent has not supplied YET is not a ' +
          'match. "They will probably say it later" is exactly the reasoning this must not use.',
        '`topicKey` MUST be one of the candidate keys exactly. Never invent one.',
        'Report `confidence` honestly as 0–1, and read it as "how sure am I that this is already ' +
          'settled". Anything below the threshold is discarded, so an inflated score does not win ' +
          'you an area, it just makes the record dishonest.',
        '`rationale` is for the administrator: one sentence naming the specific thing the ' +
          'respondent said that settles it.',
        '`respondentReason` is for the RESPONDENT, and they will see it beside this area on their ' +
          'own screen while they answer. One short plain sentence, addressed to them, grounded in ' +
          'what they told you ("You mentioned the team has doubled this year, so we\'ll spend a ' +
          'little time on hiring."). No jargon, no keys, no scores, and nothing about how the ' +
          'interview decides what to ask.'
      )
    ),
    section(
      'what_the_respondent_has_said_so_far',
      renderConveyed(params.fills, params.answers, null)
    ),
    section('candidate_areas', renderCandidates(params.candidates, undefined)),
    ...(params.goal ? [section('questionnaire_goal', params.goal)] : []),
    ...(params.settings.plannerInstructions
      ? [section('additional_guidance_from_the_administrator', params.settings.plannerInstructions)]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"clear":[{"topicKey":string,"confidence":number,"rationale":string,' +
        '"respondentReason":string}]}. An empty array is a complete and correct answer. ' +
        'No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof earlySchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Is anything already clear? Answer as JSON.' },
      ],
      maxTokens: SCOPE_PLANNER_MAX_TOKENS,
      timeoutMs: SCOPE_PLANNER_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = earlySchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"clear":[{"topicKey":string,' +
        '"confidence":number,"rationale":string,"respondentReason":string}]}.',
      onFinalFailure: () => new Error('Early-seating response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_early_topic_seating', sessionId: params.sessionId },
    }).catch((err: unknown) => {
      logger.error('early seating: logCost rejected', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      judgements: completion.value.clear.map((c) => ({
        key: c.topicKey,
        // Clamped here rather than trusted: everything downstream compares this against the
        // author's bar, and a model returning 1.4 would clear any bar there is.
        confidence: Math.min(1, Math.max(0, c.confidence)),
        rationale: c.rationale,
        respondentReason: c.respondentReason,
      })),
      costUsd: completion.costUsd ?? 0,
      provider: providerSlug,
      model,
      promptSnapshot: system,
      outputSnapshot: completion.value,
    };
  } catch (err) {
    logger.warn('early seating: call failed; seating nothing', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING;
  }
}
