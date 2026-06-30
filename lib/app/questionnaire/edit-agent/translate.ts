/**
 * Translation orchestrator for the Structure Edit Agent (precise mode).
 *
 * Resolves the seeded `app-questionnaire-structure-editor` binding and runs a single structured
 * reasoning completion that turns the admin's instruction into a validated {@link EditPlan}. The plan
 * is then executed deterministically by `resolve.ts` — the model never touches the data directly.
 * Returns a discriminated result rather than throwing, so the route maps failures to clean errors.
 *
 * Server-only (Prisma + provider). One LLM call per invocation; cost is logged.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { prisma } from '@/lib/db/client';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';

import { QUESTIONNAIRE_EDIT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import {
  EDIT_PLAN_JSON_SCHEMA,
  validateEditPlan,
  type EditPlan,
} from '@/lib/app/questionnaire/edit-agent/edit-ops';
import {
  buildTranslatePrompt,
  buildTranslateRetryMessage,
} from '@/lib/app/questionnaire/edit-agent/translate-prompt';
import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';

const PLAN_MAX_TOKENS = 4_096;
const PLAN_TIMEOUT_MS = 60_000;

export type PlanResult =
  | { ok: true; value: EditPlan }
  | { ok: false; code: string; message: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function planEditOps(
  instruction: string,
  structure: EditableStructure
): Promise<PlanResult> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_EDIT_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.error('edit-agent: structure-edit agent not seeded; run db:seed', {
      slug: QUESTIONNAIRE_EDIT_AGENT_SLUG,
    });
    return {
      ok: false,
      code: 'edit_agent_not_configured',
      message: 'The Structure Edit Agent is not configured. Run the seeds.',
    };
  }

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
    logger.error('edit-agent: no provider resolved', { error: errMsg(err) });
    return {
      ok: false,
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the Structure Edit Agent.',
    };
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('edit-agent: provider unavailable', { providerSlug, error: errMsg(err) });
    return {
      ok: false,
      code: 'provider_unavailable',
      message: 'The Structure Edit Agent’s LLM provider is unavailable.',
    };
  }

  try {
    const completion = await runStructuredCompletion<EditPlan>({
      provider,
      model,
      messages: buildTranslatePrompt(instruction, structure),
      maxTokens: PLAN_MAX_TOKENS,
      timeoutMs: PLAN_TIMEOUT_MS,
      responseSchema: EDIT_PLAN_JSON_SCHEMA,
      responseSchemaName: 'edit_plan',
      parse: (raw) => tryParseJson(raw, validateEditPlan),
      retryUserMessage: buildTranslateRetryMessage(),
      onFinalFailure: () => new Error('Edit plan was not valid against the schema after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'structure-edit-agent', versionId: structure.versionId },
    }).catch((err) => {
      logger.error('edit-agent: logCost rejected', { error: errMsg(err) });
    });

    return { ok: true, value: completion.value };
  } catch (err) {
    logger.error('edit-agent: translation failed', {
      versionId: structure.versionId,
      error: errMsg(err),
    });
    return {
      ok: false,
      code: 'plan_failed',
      message: 'The Structure Edit Agent could not produce a plan. Please try again.',
    };
  }
}
