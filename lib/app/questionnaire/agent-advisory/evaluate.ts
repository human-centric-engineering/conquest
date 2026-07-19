/**
 * Deterministic evaluation of the questionnaire agents' current settings against
 * the curated advisory recommendations (see `./recommendations`).
 *
 * Powers the Agent Settings Evaluation admin surface. For each app agent it
 * computes: the currently-resolved model (explicit per-agent model, else the
 * task-tier default), the recommended model / temperature / maxTokens /
 * reasoning effort, a cost trade-off (blended $/M from the provider-model rows
 * plus a maxTokens-bounded per-call estimate), whether temperature is a no-op on
 * the resolved model (gpt-5 family ignores it), real 30-day spend from the cost
 * logs, and an `isOptimal` verdict.
 *
 * Server-only (Prisma + settings resolver). Reads only — applying changes goes
 * through the existing settings / agent PATCH endpoints.
 */

import { prisma } from '@/lib/db/client';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { getCostBreakdown } from '@/lib/orchestration/llm/cost-reports';
import { deriveParamProfile } from '@/lib/orchestration/llm/model-heuristics';
import { narrowParamProfile } from '@/lib/orchestration/llm/db-model-adapter';
import {
  AGENT_RECOMMENDATIONS,
  TASK_TIER_RECOMMENDATIONS,
  INFRA_DEFAULT_RECOMMENDATIONS,
  type AdvisoryReasoningEffort,
  type AdvisoryTaskTier,
} from '@/lib/app/questionnaire/agent-advisory/recommendations';

/** Window (days) for the actual-spend lookup shown per agent. */
const ACTUALS_WINDOW_DAYS = 30;

interface ModelCostRef {
  modelId: string;
  name: string | null;
  /** Blended (input+output)/2 $/M from the provider-model row; null if unknown. */
  costPerMillionUsd: number | null;
  /** False for the gpt-5 / o-series `openai-reasoning` profile (temperature ignored). */
  honorsTemperature: boolean;
}

export interface TaskTierEvaluation {
  tier: AdvisoryTaskTier;
  label: string;
  currentModel: string | null;
  recommendedModel: string;
  currentModelPerMillionUsd: number | null;
  recommendedModelPerMillionUsd: number | null;
  isOptimal: boolean;
  rationale: string;
}

export interface InfraDefaultEvaluation {
  tier: 'embeddings' | 'audio';
  currentModel: string | null;
  recommendedModel: string;
  isOptimal: boolean;
  rationale: string;
}

export interface AgentSettingEvaluation {
  slug: string;
  /** Present only if the agent row exists (seeded / flag on). */
  agentId: string;
  label: string;
  role: string;
  taskTier: AdvisoryTaskTier;
  current: {
    /** Explicit per-agent model override, or null when inheriting the tier default. */
    explicitModel: string | null;
    /** What actually runs: explicit model, else the tier default (null if unset). */
    resolvedModel: string | null;
    temperature: number;
    maxTokens: number;
    reasoningEffort: string | null;
  };
  recommended: {
    model: string;
    /** True when `model` is a per-agent override of the tier default. */
    isOverride: boolean;
    temperature: number;
    maxTokens: number;
    reasoningEffort: AdvisoryReasoningEffort | null;
  };
  cost: {
    currentModelPerMillionUsd: number | null;
    recommendedModelPerMillionUsd: number | null;
    /** maxTokens-bounded per-call output-cost estimate (rough, input excluded). */
    currentEstPerCallUsd: number | null;
    recommendedEstPerCallUsd: number | null;
    deltaPerCallUsd: number | null;
    deltaPct: number | null;
  };
  actuals: {
    windowDays: number;
    spendUsd: number | null;
    calls: number | null;
  };
  flags: {
    /** Agent sets a temperature the resolved model ignores (gpt-5 family). */
    temperatureIgnored: boolean;
    /** Resolved model has no pricing row — cost figures are null. */
    pricingUnknown: boolean;
    /** No model resolved at all (tier default unset and no override). */
    modelUnresolved: boolean;
  };
  isOptimal: boolean;
  rationale: string;
}

export interface AgentSettingsEvaluation {
  generatedAt: string;
  taskTiers: TaskTierEvaluation[];
  infraDefaults: InfraDefaultEvaluation[];
  agents: AgentSettingEvaluation[];
}

function honorsTemperature(
  modelId: string,
  providerSlug: string,
  rawParamProfile: string | null
): boolean {
  const profile = narrowParamProfile(rawParamProfile) ?? deriveParamProfile(modelId, providerSlug);
  return profile !== 'openai-reasoning';
}

/** Rough per-call output-cost estimate: blended $/M × maxTokens. Input excluded. */
function estPerCall(costPerMillionUsd: number | null, maxTokens: number): number | null {
  if (costPerMillionUsd === null) return null;
  return (costPerMillionUsd * maxTokens) / 1_000_000;
}

/**
 * Evaluate every covered questionnaire agent's settings against the advisory
 * recommendations. Agents whose rows don't exist (not seeded) are omitted.
 *
 * @param now - injectable clock for the actuals window (defaults to wall clock).
 */
export async function evaluateAgentSettings(
  now: Date = new Date()
): Promise<AgentSettingsEvaluation> {
  const slugs = AGENT_RECOMMENDATIONS.map((r) => r.slug);

  // 1. Current task-tier + infra defaults.
  const [reasoningDefault, chatDefault, routingDefault, embeddingsDefault, audioDefault] =
    await Promise.all([
      getDefaultModelForTaskOrNull('reasoning'),
      getDefaultModelForTaskOrNull('chat'),
      getDefaultModelForTaskOrNull('routing'),
      getDefaultModelForTaskOrNull('embeddings'),
      getDefaultModelForTaskOrNull('audio'),
    ]);
  const tierDefaults: Record<AdvisoryTaskTier, string | null> = {
    reasoning: reasoningDefault,
    chat: chatDefault,
    routing: routingDefault,
  };

  // 2. Provider-model cost/profile map, keyed by modelId.
  const modelRows = await prisma.aiProviderModel.findMany({
    select: {
      modelId: true,
      name: true,
      providerSlug: true,
      paramProfile: true,
      costPerMillionTokens: true,
    },
  });
  const costMap = new Map<string, ModelCostRef>();
  for (const row of modelRows) {
    // Last write wins on duplicate modelId (e.g. Azure/OpenAI both expose
    // gpt-4o, which is also the chat-tier default). Fine for a display estimate:
    // duplicate rows for the same modelId carry the same blended cost, so the
    // chosen row's figure is stable.
    costMap.set(row.modelId, {
      modelId: row.modelId,
      name: row.name,
      costPerMillionUsd: row.costPerMillionTokens,
      honorsTemperature: honorsTemperature(row.modelId, row.providerSlug, row.paramProfile),
    });
  }
  const perMillion = (modelId: string | null): number | null =>
    modelId ? (costMap.get(modelId)?.costPerMillionUsd ?? null) : null;

  // 3. Agent rows by slug.
  const agentRows = await prisma.aiAgent.findMany({
    where: { slug: { in: slugs } },
    select: {
      id: true,
      slug: true,
      model: true,
      temperature: true,
      maxTokens: true,
      reasoningEffort: true,
    },
  });
  const agentBySlug = new Map(agentRows.map((a) => [a.slug, a]));

  // 4. Actual 30-day spend per agent.
  const dateFrom = new Date(now.getTime() - ACTUALS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const actualsByAgentId = new Map<string, { spendUsd: number; calls: number }>();
  try {
    const breakdown = await getCostBreakdown({ groupBy: 'agent', dateFrom, dateTo: now });
    for (const row of breakdown.rows) {
      actualsByAgentId.set(row.key, { spendUsd: row.totalCostUsd, calls: row.count });
    }
  } catch {
    // Cost logs unavailable — actuals stay null; estimates still render.
  }

  // 5. Per-agent evaluation.
  const agents: AgentSettingEvaluation[] = [];
  for (const rec of AGENT_RECOMMENDATIONS) {
    const row = agentBySlug.get(rec.slug);
    if (!row) continue; // not seeded / flag off

    const explicitModel = row.model && row.model.length > 0 ? row.model : null;
    const resolvedModel = explicitModel ?? tierDefaults[rec.taskTier];
    const recommendedModel =
      rec.overrideModel ?? TASK_TIER_RECOMMENDATIONS[rec.taskTier].recommendedModel;

    const currentPerMillion = perMillion(resolvedModel);
    const recommendedPerMillion = perMillion(recommendedModel);
    const currentEst = estPerCall(currentPerMillion, row.maxTokens);
    const recommendedEst = estPerCall(recommendedPerMillion, rec.recommendedMaxTokens);
    const deltaPerCall =
      currentEst !== null && recommendedEst !== null ? recommendedEst - currentEst : null;
    const deltaPct =
      deltaPerCall !== null && currentEst !== null && currentEst > 0
        ? (deltaPerCall / currentEst) * 100
        : null;

    const resolvedRef = resolvedModel ? costMap.get(resolvedModel) : undefined;
    const temperatureIgnored = !!resolvedRef && !resolvedRef.honorsTemperature;
    const pricingUnknown = resolvedModel !== null && currentPerMillion === null;
    const modelUnresolved = resolvedModel === null;

    const actuals = actualsByAgentId.get(row.id) ?? null;

    const isOptimal =
      resolvedModel === recommendedModel &&
      row.temperature === rec.recommendedTemperature &&
      row.maxTokens === rec.recommendedMaxTokens &&
      (row.reasoningEffort ?? null) === (rec.recommendedReasoningEffort ?? null);

    agents.push({
      slug: rec.slug,
      agentId: row.id,
      label: rec.label,
      role: rec.role,
      taskTier: rec.taskTier,
      current: {
        explicitModel,
        resolvedModel,
        temperature: row.temperature,
        maxTokens: row.maxTokens,
        reasoningEffort: row.reasoningEffort ?? null,
      },
      recommended: {
        model: recommendedModel,
        isOverride: rec.overrideModel !== null,
        temperature: rec.recommendedTemperature,
        maxTokens: rec.recommendedMaxTokens,
        reasoningEffort: rec.recommendedReasoningEffort,
      },
      cost: {
        currentModelPerMillionUsd: currentPerMillion,
        recommendedModelPerMillionUsd: recommendedPerMillion,
        currentEstPerCallUsd: currentEst,
        recommendedEstPerCallUsd: recommendedEst,
        deltaPerCallUsd: deltaPerCall,
        deltaPct,
      },
      actuals: {
        windowDays: ACTUALS_WINDOW_DAYS,
        spendUsd: actuals ? actuals.spendUsd : null,
        calls: actuals ? actuals.calls : null,
      },
      flags: { temperatureIgnored, pricingUnknown, modelUnresolved },
      isOptimal,
      rationale: rec.rationale,
    });
  }

  // 6. Task-tier + infra default evaluations.
  const taskTiers: TaskTierEvaluation[] = (['reasoning', 'chat', 'routing'] as const).map(
    (tier) => {
      const tr = TASK_TIER_RECOMMENDATIONS[tier];
      const currentModel = tierDefaults[tier];
      return {
        tier,
        label: tr.label,
        currentModel,
        recommendedModel: tr.recommendedModel,
        currentModelPerMillionUsd: perMillion(currentModel),
        recommendedModelPerMillionUsd: perMillion(tr.recommendedModel),
        isOptimal: currentModel === tr.recommendedModel,
        rationale: tr.rationale,
      };
    }
  );

  const infraDefaults: InfraDefaultEvaluation[] = [
    {
      tier: 'embeddings',
      currentModel: embeddingsDefault,
      recommendedModel: INFRA_DEFAULT_RECOMMENDATIONS.embeddings.recommendedModel,
      isOptimal: embeddingsDefault === INFRA_DEFAULT_RECOMMENDATIONS.embeddings.recommendedModel,
      rationale: INFRA_DEFAULT_RECOMMENDATIONS.embeddings.rationale,
    },
    {
      tier: 'audio',
      currentModel: audioDefault,
      recommendedModel: INFRA_DEFAULT_RECOMMENDATIONS.audio.recommendedModel,
      isOptimal: audioDefault === INFRA_DEFAULT_RECOMMENDATIONS.audio.recommendedModel,
      rationale: INFRA_DEFAULT_RECOMMENDATIONS.audio.rationale,
    },
  ];

  return {
    generatedAt: now.toISOString(),
    taskTiers,
    infraDefaults,
    agents,
  };
}
