/**
 * The routing selector — "which questionnaire next?"
 *
 * Three tiers, in order:
 *
 *  1. **Deterministic rules** (`routing/rules.ts`). First match wins and the LLM is never called.
 *  2. **The LLM selector** (this module's `askSelector`) when no rule matched.
 *  3. **The configured fallback** (`routing/fallback.ts`) when the selector errors, names an
 *     unknown step, or reports confidence below the experience's threshold.
 *
 * `selectNextStep` **never throws**. The respondent is standing at a fork waiting for an answer;
 * every failure mode resolves to a decision rather than an exception, and the decision records
 * which tier produced it so an admin can tell an AI judgement from a hard rule from a safety net.
 *
 * The selector deliberately does NOT see the raw transcript. The carry-over data-slot digest is
 * better signal per token, and inlining a full conversation would blow the context budget on the
 * one call the respondent is actively waiting for.
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
import { fillPromptText } from '@/lib/app/questionnaire/experiences/carryover/text';
import { EXPERIENCE_ROUTER_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';
import type { CarryOverContext } from '@/lib/app/questionnaire/experiences/run/types';
import type { CandidateStep } from '@/lib/app/questionnaire/experiences/routing/types';
import type {
  ExperienceRoutingFallback,
  RoutingDecision,
} from '@/lib/app/questionnaire/experiences/types';
import { applyRoutingFallback } from '@/lib/app/questionnaire/experiences/routing/fallback';

/**
 * Hard ceiling on the selector call.
 *
 * Short on purpose: the respondent is waiting, and a deterministic fallback delivered in 12
 * seconds is a better experience than a perfect answer delivered in 60.
 */
const SELECTOR_TIMEOUT_MS = 12_000;
const SELECTOR_MAX_TOKENS = 600;

/** How many carry-over fills to inline. Beyond this the prompt stops paying for itself. */
const MAX_FILLS_IN_PROMPT = 40;
const FILL_CHARS = 400;

const selectorSchema = z.object({
  decision: z.enum(['conclude', 'route']),
  selectedStepKey: z.string().nullable(),
  confidence: z.number(),
  rationale: z.string(),
  respondentMessage: z.string(),
});

export interface SelectNextStepParams {
  experienceId: string;
  /** Candidate steps, already filtered to those with a questionnaire attached. */
  candidates: readonly CandidateStep[];
  carryOver: CarryOverContext;
  /** Admin-authored guidance appended to the base prompt. */
  routingInstructions: string | null;
  fallback: ExperienceRoutingFallback;
  minConfidence: number;
  /** Nominated step for the `default_step` fallback. */
  defaultStepKey?: string | null;
}

/** The decision plus whatever the LLM call cost, so the caller can bill it to the run. */
export interface SelectNextStepResult {
  decision: RoutingDecision;
  costUsd: number;
  provider: string | null;
  model: string | null;
  /** The raw prompt + output, for the AppAiRun snapshot. Null when no LLM call was made. */
  promptSnapshot: string | null;
  outputSnapshot: unknown;
}

function renderCarryOver(carryOver: CarryOverContext): string {
  const fills = carryOver.fills
    .slice(0, MAX_FILLS_IN_PROMPT)
    .map((f) => {
      const theme = f.theme ? ` (${f.theme})` : '';
      return `- [${f.key}] ${f.name}${theme}: ${fillPromptText(f, FILL_CHARS)}`;
    })
    .join('\n');

  const parts = [fills || '(no structured answers were captured)'];
  if (carryOver.briefing)
    parts.push(`\nSummary of the conversation so far:\n${carryOver.briefing}`);
  return parts.join('\n');
}

function renderCandidates(candidates: readonly CandidateStep[]): string {
  return candidates
    .map((c) => {
      const lines = [`- key: ${c.stepKey}`, `  title: ${c.title}`];
      if (c.purpose) lines.push(`  purpose: ${c.purpose}`);
      if (c.selectionCriteria) lines.push(`  choose when: ${c.selectionCriteria}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Ask the LLM. Returns null on any failure — the caller then applies the fallback.
 *
 * Never throws: this is the one call standing between a respondent and their next question.
 */
async function askSelector(params: SelectNextStepParams): Promise<{
  value: z.infer<typeof selectorSchema>;
  costUsd: number;
  provider: string;
  model: string;
  prompt: string;
} | null> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: EXPERIENCE_ROUTER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.warn('experience selector: router agent not configured; falling back', {
      experienceId: params.experienceId,
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
    logger.warn('experience selector: no provider resolved; falling back', {
      experienceId: params.experienceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const system = joinSections(
    section(
      'role',
      'You decide what a respondent should do next in a multi-part questionnaire journey. You have ' +
        'a digest of what they conveyed in the part they just finished, and a set of candidate ' +
        'follow-up questionnaires. Choose the ONE follow-up that best fits what you have learnt — ' +
        'or decide the journey should conclude with a summary instead.'
    ),
    section(
      'rules',
      joinSections(
        'Weigh each candidate against its "choose when" criteria first — those are the author\'s own ' +
          'account of when that follow-up is right, and they outrank your general judgement.',
        'Choose `conclude` when no candidate genuinely fits, when the respondent has already covered ' +
          'what the candidates would ask, or when continuing would plainly not serve them. ' +
          'Concluding is a good outcome, not a failure.',
        'Report `confidence` honestly as 0–1. A low score is useful information — it routes the ' +
          'decision to a safe default rather than acting on a guess. Do not inflate it.',
        '`selectedStepKey` MUST be one of the candidate keys exactly, or null when concluding. ' +
          'Never invent a key.',
        '`rationale` is for the administrator: one or two sentences on what in the digest drove ' +
          'this, naming the specific signals.',
        '`respondentMessage` is spoken to the respondent at the handover: one warm, plain sentence. ' +
          'Never mention keys, scores, confidence, or that a decision was made about them.'
      )
    ),
    section('what_the_respondent_conveyed', renderCarryOver(params.carryOver)),
    section('candidates', renderCandidates(params.candidates)),
    ...(params.routingInstructions
      ? [section('additional_guidance_from_the_administrator', params.routingInstructions)]
      : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"decision":"conclude"|"route","selectedStepKey":string|null,' +
        '"confidence":number,"rationale":string,"respondentMessage":string}. No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof selectorSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Make the routing decision now as JSON.' },
      ],
      maxTokens: SELECTOR_MAX_TOKENS,
      timeoutMs: SELECTOR_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = selectorSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"decision":"conclude"|"route",' +
        '"selectedStepKey":string|null,"confidence":number,"rationale":string,"respondentMessage":string}.',
      onFinalFailure: () => new Error('Selector response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_experience_routing', experienceId: params.experienceId },
    }).catch((err: unknown) => {
      // Best-effort, but a silent swallow would hide a systematic cost-logging outage.
      logger.error('experience selector: logCost rejected', {
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
    logger.warn('experience selector: call failed; falling back', {
      experienceId: params.experienceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the fork. Never throws.
 *
 * Rules are the caller's responsibility (they need the fills and the rule rows, and resolve
 * without any of this module's I/O) — by the time `selectNextStep` is called, no rule matched.
 */
export async function selectNextStep(params: SelectNextStepParams): Promise<SelectNextStepResult> {
  const noCall = {
    costUsd: 0,
    provider: null,
    model: null,
    promptSnapshot: null,
    outputSnapshot: null,
  };

  // Nothing to choose between: conclude without spending a token on a foregone decision.
  if (params.candidates.length === 0) {
    return {
      decision: applyRoutingFallback(
        params.fallback,
        params.candidates,
        'no candidate steps are available',
        params.defaultStepKey
      ),
      ...noCall,
    };
  }

  const asked = await askSelector(params);
  if (!asked) {
    return {
      decision: applyRoutingFallback(
        params.fallback,
        params.candidates,
        'the selector could not be reached',
        params.defaultStepKey
      ),
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
  const { decision, selectedStepKey, confidence, rationale, respondentMessage } = asked.value;

  // Clamp rather than reject: a model reporting 1.2 means "very confident", and discarding an
  // otherwise-good decision over a malformed scalar would be perverse.
  const clamped = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;

  if (clamped < params.minConfidence) {
    return {
      decision: applyRoutingFallback(
        params.fallback,
        params.candidates,
        `the selector reported ${clamped.toFixed(2)} confidence, below the ${params.minConfidence.toFixed(2)} threshold (it proposed: ${rationale})`,
        params.defaultStepKey
      ),
      ...withCall,
    };
  }

  if (decision === 'conclude') {
    return {
      decision: {
        decision: 'conclude',
        selectedStepKey: null,
        confidence: clamped,
        rationale,
        respondentMessage,
        source: 'llm',
      },
      ...withCall,
    };
  }

  // Routing: the named key must actually be a candidate. A hallucinated key is exactly the case
  // the fallback exists for — never route into something that does not exist.
  const valid = params.candidates.some((c) => c.stepKey === selectedStepKey);
  if (!selectedStepKey || !valid) {
    return {
      decision: applyRoutingFallback(
        params.fallback,
        params.candidates,
        `the selector named "${selectedStepKey ?? 'nothing'}", which is not one of the candidates`,
        params.defaultStepKey
      ),
      ...withCall,
    };
  }

  return {
    decision: {
      decision: 'route',
      selectedStepKey,
      // The model's OWN clamped confidence, not `routeDecision`'s certain-by-construction 1 —
      // that constant is right for rules and budget stops, and would misreport a judgement.
      confidence: clamped,
      rationale,
      respondentMessage,
      source: 'llm',
    },
    ...withCall,
  };
}
