/**
 * The respondent-amendment trigger (P17.6) — honouring "actually, ask me about talent".
 *
 * Called after a turn is persisted, beside {@link maybePlanScope}. By then the plan (if any) is on
 * the row, so an amendment can never race the decision it amends.
 *
 * ## Fail-soft, always
 *
 * Never throws. Every failure leaves the plan exactly as it was — the respondent's request simply
 * goes unhonoured, which is the same outcome as the feature being off, and they can ask again. A
 * turn that 500s because an optional courtesy failed is not a trade worth making.
 *
 * ## What it costs on an ordinary turn
 *
 * One narrowed settings read and a regex. The cue gate rules out virtually every turn before any
 * topic query, and a label match resolves most of the survivors without a model call — so the model
 * call happens only when a respondent has plainly asked for something and the wording did not name
 * it outright.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { z } from 'zod';

import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import {
  SCOPE_PLANNER_AGENT_SLUG,
  SCOPE_PLANNER_TIMEOUT_MS,
} from '@/lib/app/questionnaire/scope/constants';
import {
  amendableTopics,
  applyAmendment,
  looksLikeTopicRequest,
  matchTopicByLabel,
} from '@/lib/app/questionnaire/scope/amendment';
import {
  narrowAdaptiveScopeSettings,
  narrowInterviewPlan,
  type PlanAmendment,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { toTopic, TOPIC_SELECT } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/** Output cap for the resolver. One key or nothing — it needs almost no room. */
const AMENDMENT_MAX_TOKENS = 300;

const resolverSchema = z.object({
  /** The requested topic's key, or an empty string when the message asks for none of them. */
  topicKey: z.string(),
});

/** What the trigger did. Never an error. */
export type AmendPlanResult =
  { kind: 'skipped'; reason: string } | { kind: 'amended'; amendment: PlanAmendment };

export interface MaybeAmendPlanInput {
  sessionId: string;
  /** The respondent's message on the turn just persisted. */
  message: string;
  /** Turn ordinal the request arrived on, so the acknowledgement gets exactly one outing. */
  atTurn: number;
}

/**
 * Honour a respondent's request to cover an excluded topic, if there is one. Never throws.
 *
 * Returns `skipped` for every ordinary turn — the feature off, no plan yet, nothing excluded, or a
 * message that is plainly just an answer.
 */
export async function maybeAmendPlan(input: MaybeAmendPlanInput): Promise<AmendPlanResult> {
  const { sessionId, message, atTurn } = input;
  try {
    // The cheapest possible rejection, before any query at all: nearly every respondent turn is an
    // answer, not a request.
    if (!looksLikeTopicRequest(message)) return { kind: 'skipped', reason: 'no request cue' };

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        versionId: true,
        interviewPlan: true,
        version: { select: { goal: true, config: { select: { adaptiveScope: true } } } },
      },
    });
    if (!session) return { kind: 'skipped', reason: 'session not found' };

    const settings = narrowAdaptiveScopeSettings(session.version.config?.adaptiveScope);
    if (!settings.enabled) return { kind: 'skipped', reason: 'adaptive scope is off' };
    if (!settings.allowRespondentAmendment) {
      return { kind: 'skipped', reason: 'amendment is not allowed on this version' };
    }

    const plan = narrowInterviewPlan(session.interviewPlan);
    // No plan means the opening is still running and nothing has been excluded yet — there is
    // literally nothing to amend, and the planner is about to consider everything anyway.
    if (!plan) return { kind: 'skipped', reason: 'no plan yet' };

    const rows = await prisma.appQuestionnaireTopic.findMany({
      where: { versionId: session.versionId },
      orderBy: { ordinal: 'asc' },
      select: TOPIC_SELECT,
    });
    const candidates = amendableTopics(plan, rows.map(toTopic));
    if (candidates.length === 0) return { kind: 'skipped', reason: 'nothing excluded to add' };

    // Tier 2: the free resolution. "Ask me about talent" against a topic named "Talent".
    let topic = matchTopicByLabel(message, candidates);
    let resolvedBy: 'label' | 'agent' = 'label';
    let costUsd = 0;

    // Tier 3: judgement, only when the wording did not name the topic outright.
    if (!topic) {
      const resolved = await resolveWithAgent({
        sessionId,
        message,
        candidates,
        goal: session.version.goal,
      });
      if (!resolved) return { kind: 'skipped', reason: 'request did not resolve to a topic' };
      topic = resolved.topic;
      resolvedBy = 'agent';
      costUsd = resolved.costUsd;
    }

    const { plan: amended, amendment } = applyAmendment(plan, topic, {
      request: message,
      atTurn,
      at: new Date().toISOString(),
    });

    // Guarded on the plan still being the one we amended: two concurrent turns on one session is
    // not a state the composer lock allows, but writing the whole blob back unconditionally would
    // silently drop a plan written between the read and the write if it ever became one.
    const written = await prisma.appQuestionnaireSession.updateMany({
      where: { id: sessionId, interviewPlan: { not: Prisma.DbNull } },
      data: { interviewPlan: jsonInput(amended) },
    });
    if (written.count === 0) return { kind: 'skipped', reason: 'plan disappeared mid-amendment' };

    // Recorded like every other scope decision — and marked as an amendment, because routing
    // analytics must be able to tell a respondent's correction from the planner's own success.
    void recordAiRun({
      subjectKind: 'session',
      subjectId: sessionId,
      kind: 'scope_plan',
      status: 'succeeded',
      provider: resolvedBy === 'agent' ? 'resolved-at-runtime' : 'deterministic',
      model: resolvedBy === 'agent' ? 'resolved-at-runtime' : 'deterministic',
      costUsd,
      detail: {
        source: 'respondent',
        amendment: true,
        resolvedBy,
        topicKey: topic.key,
        atTurn,
        candidateKeys: candidates.map((t) => t.key),
      },
    });

    logger.info('adaptive scope: plan amended at the respondent’s request', {
      sessionId,
      topicKey: topic.key,
      resolvedBy,
      atTurn,
    });

    return { kind: 'amended', amendment };
  } catch (err) {
    logger.error('adaptive scope: amendment failed; the plan is unchanged', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'skipped', reason: 'amendment failed' };
  }
}

/**
 * Resolve an ambiguous request to one of the candidate topics with one small model call.
 *
 * Returns null on ANY failure or a non-match — including a key the model invented. The default is
 * always "no amendment": widening an interview on a misread is worse than missing a request the
 * respondent can simply repeat.
 *
 * Reuses the Scope Planner agent rather than seeding a second one: it is the same judgement over
 * the same vocabulary, and an operator tuning "how this instrument decides what to ask" should not
 * have to find two agents to do it.
 */
async function resolveWithAgent(params: {
  sessionId: string;
  message: string;
  candidates: readonly Topic[];
  goal: string | null;
}): Promise<{ topic: Topic; costUsd: number } | null> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: SCOPE_PLANNER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) return null;

  let providerSlug: string;
  let model: string;
  try {
    // The `routing` tier, not `reasoning`: this is a short classification over a handful of labels,
    // and it runs while a respondent waits. The planner's own judgement call is the expensive one.
    const resolved = await resolveAgentProviderAndModel(agent, 'routing');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch {
    return null;
  }

  const system = joinSections(
    section(
      'role',
      'A respondent in an interview has asked to be asked about something. Decide which — if any — ' +
        'of the topics below they meant.'
    ),
    section(
      'rules',
      joinSections(
        'Match on MEANING, not wording. "Can we cover hiring?" means a topic called "People & ' +
          'capability".',
        'Return an empty string when the message does not clearly ask for any of these topics. That ' +
          'is the right answer far more often than not — an interview widened on a misread wastes ' +
          "the respondent's time on something they did not ask for.",
        'Never invent a key. `topicKey` must be one of the listed keys exactly, or empty.'
      )
    ),
    section('what_the_respondent_said', params.message.slice(0, 1_000)),
    section(
      'topics_they_could_be_asking_for',
      params.candidates.map((t) => `- key: ${t.key}\n  name: ${t.label}`).join('\n\n')
    ),
    ...(params.goal ? [section('questionnaire_goal', params.goal)] : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"topicKey":string}. Use "" for none. No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof resolverSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Which topic did they ask for? Reply as JSON.' },
      ],
      maxTokens: AMENDMENT_MAX_TOKENS,
      timeoutMs: SCOPE_PLANNER_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = resolverSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage: 'That was not valid JSON. Reply with ONLY {"topicKey":string}.',
      onFinalFailure: () => new Error('Amendment resolver returned invalid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_scope_amendment', sessionId: params.sessionId },
    }).catch((err: unknown) => {
      logger.error('scope amendment: logCost rejected', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const key = completion.value.topicKey.trim();
    if (key.length === 0) return null;
    // A hallucinated key resolves to no amendment, never to the nearest topic: "close enough" here
    // means asking someone about something they did not raise.
    const topic = params.candidates.find((t) => t.key === key);
    return topic ? { topic, costUsd: completion.costUsd } : null;
  } catch (err) {
    logger.warn('scope amendment: resolver call failed; no amendment', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
