/**
 * The AI leg of batch apply: rewrite one accepted change in the reviewer's words.
 *
 * A reviewer triaging an evaluation run may attach a free-text instruction to any suggestion. Until
 * this module existed, the batch reported those as `needs_ai` and left them accepted — honest, but
 * a dead end. This is what closes it: one structured completion per steered finding, whose output
 * is folded back into the judge's op and then applied down the ordinary path, with the same
 * validation, the same staleness re-check and the same fork rule as an unsteered change.
 *
 * **The model never touches the data.** It returns text for the op it was given
 * (`steeredEditSchema`), `mergeSteeredEdit` rebuilds the op around that text from the original, and
 * `applyFinding` re-validates the result against the live version exactly as it validates a judge's
 * op or an admin's typed override. The AI leg is a rewriter sitting in front of an unchanged apply
 * path, not a second way into the questionnaire.
 *
 * Shaped like `edit-agent/translate.ts` rather than a capability: this is a route-level step in one
 * admin action, not a tool an agent chooses to call. Returns a discriminated result instead of
 * throwing, because every failure here has a per-finding report line waiting for it — a steer the
 * model could not produce leaves the finding accepted and says so, and never applies the judge's
 * op with the reviewer's sentence quietly dropped.
 *
 * Server-only (Prisma + provider). One LLM call per invocation; cost and provenance both recorded.
 */

import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';

import { QUESTIONNAIRE_STEER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation/types';
import {
  buildSteerPrompt,
  buildSteerRetryMessage,
  STEER_PROMPT_VERSION,
  type SteerPromptInput,
} from '@/lib/app/questionnaire/evaluation/steer-prompt';
import {
  mergeSteeredEdit,
  STEER_RESULT_JSON_SCHEMA,
  validateSteerResult,
  type SteerResult,
} from '@/lib/app/questionnaire/evaluation/steer-schema';

/**
 * Output budget. One rewritten change plus two short lines of prose — small. Sized well above that
 * anyway because a reasoning model's hidden tokens come out of the same allowance, and a response
 * truncated mid-JSON fails a steer the reviewer explicitly asked for.
 */
const STEER_MAX_TOKENS = 2_048;

/**
 * Per-call timeout. Shorter than the reconciler's 90s: this is one question, and the reviewer is
 * sitting in front of a batch that cannot finish until every steer resolves.
 *
 * `runStructuredCompletion` gives its retry a *fresh* timeout, so the real worst case per finding
 * is twice this — which is what the batch's concurrency window is sized against.
 */
export const STEER_TIMEOUT_MS = 45_000;

/** What a steer attempt produced: a change ready to apply, or a reason it is not being applied. */
export type SteerOutcome =
  | { ok: true; edit: ProposedEdit; note: string; unhonoured: string | null }
  | { ok: false; code: string; message: string };

/** Everything the call needs beyond the prompt: who triggered it, and what to file it under. */
export interface SteerContext {
  /** The version the run belongs to — the provenance record's subject. */
  versionId: string;
  runId: string;
  findingId: string;
  userId: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * File the attempt against the version, failures included.
 *
 * A steer that errored is worth keeping for the same reason a failed critic run is: the reviewer
 * saw "not applied" and will ask why later, and "the model returned an op we refused" is a better
 * answer than an absence. `provider`/`model` read `n/a` when the call never reached a provider —
 * the agreed spelling for "this never ran", not a gap to fill in.
 */
function record(
  ctx: SteerContext,
  fields: {
    status: 'succeeded' | 'failed';
    provider: string;
    model: string;
    prompt?: unknown;
    output?: unknown;
    inputTokens?: number | null;
    outputTokens?: number | null;
    durationMs?: number | null;
    detail: Record<string, unknown>;
    error?: string | null;
  }
): void {
  void recordAiRun({
    subjectKind: 'version',
    subjectId: ctx.versionId,
    versionId: ctx.versionId,
    kind: 'evaluation_steer',
    status: fields.status,
    provider: fields.provider,
    model: fields.model,
    promptSnapshot: fields.prompt ?? null,
    outputSnapshot: fields.output ?? null,
    inputTokens: fields.inputTokens ?? null,
    outputTokens: fields.outputTokens ?? null,
    durationMs: fields.durationMs ?? null,
    detail: { runId: ctx.runId, findingId: ctx.findingId, ...fields.detail },
    error: fields.error ?? null,
    promptVersion: STEER_PROMPT_VERSION,
    triggeredByUserId: ctx.userId,
  });
}

/**
 * Rewrite one accepted change so it follows the reviewer's instruction.
 *
 * `input.op` must be a steerable op (`isSteerableOp`) — the batch checks before calling, because
 * "your instruction needs wording to change, and this suggestion moves the question" is a report
 * line, not a model call to pay for.
 */
export async function steerProposedEdit(
  input: SteerPromptInput,
  ctx: SteerContext
): Promise<SteerOutcome> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_STEER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.error('evaluation steer: agent not seeded; run db:seed', {
      slug: QUESTIONNAIRE_STEER_AGENT_SLUG,
      findingId: ctx.findingId,
    });
    record(ctx, {
      status: 'failed',
      provider: 'n/a',
      model: 'n/a',
      detail: { op: input.op.op },
      error: 'steer agent not seeded',
    });
    return {
      ok: false,
      code: 'steer_agent_not_configured',
      message: 'The suggestion steer agent is not configured. Run the seeds.',
    };
  }

  // Rewriting a question so it satisfies both a critique and a reviewer's constraint is analysis —
  // the `reasoning` tier, the same as the judges whose work it is reconciling with.
  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(
      { provider: agent.provider, model: agent.model, fallbackProviders: agent.fallbackProviders },
      'reasoning'
    );
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('evaluation steer: no provider resolved', {
      findingId: ctx.findingId,
      error: errMsg(err),
    });
    record(ctx, {
      status: 'failed',
      provider: 'n/a',
      model: 'n/a',
      detail: { op: input.op.op },
      error: errMsg(err),
    });
    return {
      ok: false,
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the suggestion steer agent.',
    };
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('evaluation steer: provider unavailable', {
      findingId: ctx.findingId,
      providerSlug,
      error: errMsg(err),
    });
    record(ctx, {
      status: 'failed',
      provider: providerSlug,
      model,
      detail: { op: input.op.op },
      error: errMsg(err),
    });
    return {
      ok: false,
      code: 'provider_unavailable',
      message: 'The suggestion steer agent’s LLM provider is unavailable.',
    };
  }

  const messages = buildSteerPrompt(input);
  const startedAt = Date.now();

  let completion: StructuredCompletionResult<SteerResult>;
  try {
    completion = await runStructuredCompletion<SteerResult>({
      provider,
      model,
      messages,
      maxTokens: STEER_MAX_TOKENS,
      timeoutMs: STEER_TIMEOUT_MS,
      responseSchema: STEER_RESULT_JSON_SCHEMA,
      responseSchemaName: 'steered_edit',
      parse: (raw) => tryParseJson(raw, validateSteerResult),
      retryUserMessage: buildSteerRetryMessage(),
      onFinalFailure: () =>
        new Error('Steered edit was not valid against the schema after one retry'),
    });
  } catch (err) {
    logger.error('evaluation steer: structured completion failed', {
      findingId: ctx.findingId,
      model,
      provider: providerSlug,
      error: errMsg(err),
    });
    record(ctx, {
      status: 'failed',
      provider: providerSlug,
      model,
      prompt: messages,
      durationMs: Date.now() - startedAt,
      detail: { op: input.op.op },
      error: errMsg(err),
    });
    return {
      ok: false,
      code: 'steer_failed',
      message: 'The AI could not rewrite this change.',
    };
  }

  const durationMs = Date.now() - startedAt;

  void logCost({
    agentId: agent.id,
    operation: CostOperation.CHAT,
    model,
    provider: providerSlug,
    inputTokens: completion.tokenUsage.input,
    outputTokens: completion.tokenUsage.output,
    metadata: {
      capability: 'evaluation-steer',
      versionId: ctx.versionId,
      runId: ctx.runId,
      findingId: ctx.findingId,
    },
  }).catch((err) => {
    logger.error('evaluation steer: logCost rejected', {
      findingId: ctx.findingId,
      error: errMsg(err),
    });
  });

  // The one refusal. An op-kind switch is the model overruling the reviewer's own decision, so it
  // is rejected outright rather than partly used — and reported, because the reviewer asked for
  // something and is entitled to know it did not happen.
  const edit = mergeSteeredEdit(input.op, completion.value.revised);
  if (!edit) {
    logger.warn('evaluation steer: model returned a different op', {
      findingId: ctx.findingId,
      requested: input.op.op,
      returned: completion.value.revised.op,
    });
    record(ctx, {
      status: 'failed',
      provider: providerSlug,
      model,
      prompt: messages,
      output: completion.value,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      durationMs,
      detail: { op: input.op.op, returnedOp: completion.value.revised.op },
      error: 'steered edit changed the operation',
    });
    return {
      ok: false,
      code: 'steer_changed_op',
      message: 'The AI proposed a different kind of change from the one you accepted.',
    };
  }

  record(ctx, {
    status: 'succeeded',
    provider: providerSlug,
    model,
    prompt: messages,
    output: completion.value,
    inputTokens: completion.tokenUsage.input,
    outputTokens: completion.tokenUsage.output,
    durationMs,
    detail: {
      op: input.op.op,
      instruction: input.instruction,
      note: completion.value.note,
      unhonoured: completion.value.unhonoured ?? null,
    },
  });

  return {
    ok: true,
    edit,
    note: completion.value.note,
    unhonoured: completion.value.unhonoured ?? null,
  };
}
