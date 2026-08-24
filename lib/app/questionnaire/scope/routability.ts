/**
 * Is the opening already routable? (G03 / F17.17)
 *
 * The half of the probe allowance that needs care. Spending the opening's one follow-up on an
 * answer that was *already* specific enough to route is the failure G03 actually names: "we want
 * things to run better" is worth a follow-up; "our handovers stall waiting for one person to sign
 * off" names a section on its own and must not cost one.
 *
 * The counter that rations the probes is `scope/probe.ts`, and is pure. This module calls a model,
 * so it is kept apart — the orchestrator imports the counter and never this.
 *
 * ## Which way failure leans
 *
 * {@link assessOpeningRoutability} returns `null` for every failure: no agent, no provider, a
 * timeout, unparseable JSON. Null is NOT "routable" — the caller then spends the probe, which is
 * exactly what it would have done before this feature existed. The check may only ever *save* a
 * question, never cause one to be skipped on the strength of a call that did not happen.
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
  MAX_CANDIDATES_IN_PROBE_PROMPT,
  MAX_EVIDENCE_IN_PROBE_PROMPT,
  OPENING_PROBE_MAX_TOKENS,
  OPENING_PROBE_TIMEOUT_MS,
  PROBE_EVIDENCE_CHARS,
  SCOPE_PLANNER_AGENT_SLUG,
} from '@/lib/app/questionnaire/scope/constants';
import type { Topic } from '@/lib/app/questionnaire/scope/types';

const routabilitySchema = z.object({
  routable: z.boolean(),
  reason: z.string(),
});

/** One thing the respondent has conveyed in the opening, as the check reads it. */
export interface ProbeEvidence {
  /** What was asked — an opening question's prompt, or a data slot's name. */
  asked: string;
  /** What came back, in the respondent's words where we have them. */
  said: string;
}

export interface AssessRoutabilityParams {
  sessionId: string;
  /** The conditional topics the plan will choose between — their criteria are the whole test. */
  candidates: readonly Pick<Topic, 'key' | 'label' | 'criteria'>[];
  /** What the opening has gathered so far. */
  evidence: readonly ProbeEvidence[];
  /** The message the respondent has just sent, when this turn carried one. */
  latestMessage?: string;
  /** The questionnaire's stated goal, for framing. */
  goal?: string | null;
}

/** The check's answer, or `null` when it could not be obtained (see the module note). */
export interface RoutabilityVerdict {
  /** True ⇒ the plan could already be decided; the probe would buy nothing. */
  routable: boolean;
  /** One sentence, for the log. Never shown to the respondent. */
  reason: string;
  costUsd: number;
}

function renderEvidence(params: AssessRoutabilityParams): string {
  // Filter THEN cap. The other way round drops content rather than bounding it: twenty blank
  // entries would consume the whole budget and render "nothing captured" over an opening that was
  // in fact answered, and the check would then decide on the latest message alone.
  const lines = params.evidence
    .filter((e) => e.said.trim().length > 0)
    .slice(0, MAX_EVIDENCE_IN_PROBE_PROMPT)
    .map((e) => `- Asked: ${e.asked}\n  Answered: ${e.said.trim().slice(0, PROBE_EVIDENCE_CHARS)}`);
  const latest = params.latestMessage?.trim();
  const parts: string[] = [];
  if (lines.length > 0) parts.push(lines.join('\n'));
  // Last and labelled, because it is the answer the follow-up would be aimed at — and extraction
  // may not have folded it into the evidence above yet.
  if (latest) parts.push(`They have just said:\n"${latest.slice(0, PROBE_EVIDENCE_CHARS)}"`);
  return parts.length > 0 ? parts.join('\n\n') : '(nothing has been captured yet)';
}

function renderCandidates(candidates: AssessRoutabilityParams['candidates']): string {
  return candidates
    .slice(0, MAX_CANDIDATES_IN_PROBE_PROMPT)
    .map((t) => {
      const lines = [`- ${t.label}`];
      if (t.criteria) lines.push(`  choose when: ${t.criteria}`);
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Ask whether the opening is already routable. Never throws; returns null on any failure.
 *
 * Deliberately runs on the **planner's own agent binding**. If the model that will shortly be asked
 * to choose the topics says it could already choose them, the follow-up buys nothing — and a second
 * agent, with its own model and its own idea of what "enough" means, could disagree with the
 * planner about the very question it exists to anticipate.
 */
export async function assessOpeningRoutability(
  params: AssessRoutabilityParams
): Promise<RoutabilityVerdict | null> {
  if (params.candidates.length === 0) return null;

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
    logger.error('opening probe: agent lookup failed; the follow-up goes ahead', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!agent) return null;

  let providerSlug: string;
  let model: string;
  try {
    // The routing tier, not the planner's reasoning tier: this is a yes/no read of one answer
    // inside a live turn, and the respondent is watching a typing indicator while it runs.
    const resolved = await resolveAgentProviderAndModel(agent, 'routing');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('opening probe: no provider resolved; the follow-up goes ahead', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const system = joinSections(
    section(
      'role',
      'You are about to decide whether an interview needs ONE more follow-up question before it ' +
        'can choose which topics to cover. Follow-ups are strictly rationed, so the only question ' +
        'you answer is whether this one would change anything.'
    ),
    section(
      'rules',
      joinSections(
        'Answer `routable: true` when what the respondent has already said is enough to judge the ' +
          'candidate topics below against their criteria — even if it is brief, and even if you ' +
          'would personally like more detail. Wanting more is not the test.',
        'Answer `routable: false` ONLY when the account is too abstract to point at any topic in ' +
          'particular — a stated ambition or a slogan rather than a situation. "We want things to ' +
          'run better" names no topic; "our handovers stall waiting for one person to sign off" ' +
          'names one on its own.',
        'Read for what they MEAN, not the words they used. A topic can be named clearly by an ' +
          'account that uses none of its words.',
        'Pointing at the WRONG topic is still routable. You are judging whether a decision can be ' +
          'made, not whether you agree with it.',
        'When you genuinely cannot tell, answer `routable: false` — the interview then asks its ' +
          'follow-up, which is the recoverable mistake.',
        '`reason` is one short sentence for the administrator, naming what is or is not there.'
      )
    ),
    section('what_the_respondent_has_conveyed', renderEvidence(params)),
    section('candidate_topics', renderCandidates(params.candidates)),
    ...(params.goal ? [section('questionnaire_goal', params.goal)] : []),
    section(
      'output_format',
      'Reply with ONLY JSON: {"routable":boolean,"reason":string}. No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof routabilitySchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Answer now, as JSON.' },
      ],
      maxTokens: OPENING_PROBE_MAX_TOKENS,
      timeoutMs: OPENING_PROBE_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = routabilitySchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"routable":boolean,"reason":string}.',
      onFinalFailure: () => new Error('Routability response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_opening_probe', sessionId: params.sessionId },
    }).catch((err: unknown) => {
      logger.error('opening probe: logCost rejected', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      routable: completion.value.routable,
      reason: completion.value.reason,
      costUsd: completion.costUsd ?? 0,
    };
  } catch (err) {
    logger.warn('opening probe: check failed; the follow-up goes ahead', {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
