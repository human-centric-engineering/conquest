'use client';

/**
 * Agent Settings Evaluation — admin surface to review and tune the questionnaire
 * agents' model / temperature / maxTokens / reasoning-effort settings against the
 * deterministic advisory baseline, with cost trade-offs and a one-click apply.
 *
 * Two layers (see the curated table in `lib/app/questionnaire/agent-advisory`):
 *   1. Task-tier defaults — accepting a model recommendation PATCHes
 *      `AiOrchestrationSettings.defaultModels[tier]`, so every inheriting agent
 *      moves together.
 *   2. Per-agent cards — accepting tunes temperature / maxTokens / reasoning
 *      effort on the agent row (and, for outliers, pins an override model).
 *
 * All mutations reuse the existing orchestration PATCH endpoints; after each one
 * we re-fetch the evaluation so the verdicts stay truthful.
 */

import { useCallback, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import type {
  AgentSettingEvaluation,
  AgentSettingsEvaluation,
} from '@/lib/app/questionnaire/agent-advisory/evaluate';
import { TaskDefaultCard } from '@/components/admin/questionnaires/agent-settings/task-default-card';
import { AgentSettingCard } from '@/components/admin/questionnaires/agent-settings/agent-setting-card';

interface AgentSettingsPanelProps {
  initialEvaluation: AgentSettingsEvaluation | null;
}

const TIER_ORDER = ['reasoning', 'chat', 'routing'] as const;
const TIER_HEADINGS: Record<string, string> = {
  reasoning: 'Reasoning agents',
  chat: 'Chat agents (per-turn hot path)',
  routing: 'Routing agents',
};

export function AgentSettingsPanel({ initialEvaluation }: AgentSettingsPanelProps) {
  const [evaluation, setEvaluation] = useState<AgentSettingsEvaluation | null>(initialEvaluation);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const markSaved = useCallback((key: string) => {
    setSavedKeys((prev) => new Set(prev).add(key));
  }, []);

  const refetch = useCallback(async (): Promise<AgentSettingsEvaluation | null> => {
    const fresh = await apiClient.get<AgentSettingsEvaluation>(
      API.APP.QUESTIONNAIRES.agentSettings
    );
    setEvaluation(fresh);
    return fresh;
  }, []);

  /** PATCH a single task-tier default model (partial merge — non-destructive). */
  const applyTierModel = useCallback(async (tier: string, model: string): Promise<void> => {
    await apiClient.patch(API.ADMIN.ORCHESTRATION.SETTINGS, {
      body: { defaultModels: { [tier]: model } },
    });
  }, []);

  /** PATCH a single agent's per-agent fields (and override model when applicable). */
  const applyAgentSettings = useCallback(async (agent: AgentSettingEvaluation): Promise<void> => {
    const body: Record<string, unknown> = {
      temperature: agent.recommended.temperature,
      maxTokens: agent.recommended.maxTokens,
      reasoningEffort: agent.recommended.reasoningEffort,
    };
    if (agent.recommended.isOverride) body.model = agent.recommended.model;
    await apiClient.patch(API.ADMIN.ORCHESTRATION.agentById(agent.agentId), { body });
  }, []);

  const handleApplyTier = useCallback(
    async (tier: string, model: string) => {
      setError(null);
      setApplyingKey(`tier:${tier}`);
      try {
        await applyTierModel(tier, model);
        await refetch();
        markSaved(`tier:${tier}`);
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Failed to apply tier default.');
      } finally {
        setApplyingKey(null);
      }
    },
    [applyTierModel, refetch, markSaved]
  );

  const handleApplyAgent = useCallback(
    async (agent: AgentSettingEvaluation) => {
      setError(null);
      setApplyingKey(`agent:${agent.slug}`);
      try {
        await applyAgentSettings(agent);
        await refetch();
        markSaved(`agent:${agent.slug}`);
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Failed to update agent.');
      } finally {
        setApplyingKey(null);
      }
    },
    [applyAgentSettings, refetch, markSaved]
  );

  /** Apply an arbitrary per-agent patch (the AI suggestion from a card). */
  const handleApplyPatch = useCallback(
    async (agent: AgentSettingEvaluation, patch: Record<string, unknown>) => {
      setError(null);
      setApplyingKey(`agent:${agent.slug}`);
      try {
        await apiClient.patch(API.ADMIN.ORCHESTRATION.agentById(agent.agentId), { body: patch });
        await refetch();
        markSaved(`agent:${agent.slug}`);
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Failed to apply suggestion.');
      } finally {
        setApplyingKey(null);
      }
    },
    [refetch, markSaved]
  );

  /** Apply every non-optimal tier default, then every non-optimal agent, then refetch once. */
  const handleApplyAll = useCallback(async () => {
    if (!evaluation) return;
    setError(null);
    setBulk(true);
    const saved: string[] = [];
    try {
      for (const tier of evaluation.taskTiers) {
        if (tier.isOptimal) continue;
        await applyTierModel(tier.tier, tier.recommendedModel);
        saved.push(`tier:${tier.tier}`);
      }
      for (const agent of evaluation.agents) {
        if (agent.isOptimal) continue;
        await applyAgentSettings(agent);
        saved.push(`agent:${agent.slug}`);
      }
      await refetch();
      setSavedKeys((prev) => {
        const next = new Set(prev);
        saved.forEach((k) => next.add(k));
        return next;
      });
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Failed to apply all recommendations.'
      );
    } finally {
      setBulk(false);
    }
  }, [evaluation, applyTierModel, applyAgentSettings, refetch]);

  const handleRefresh = useCallback(async () => {
    setError(null);
    setBulk(true);
    try {
      await refetch();
      setSavedKeys(new Set());
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to refresh.');
    } finally {
      setBulk(false);
    }
  }, [refetch]);

  const pendingCount = useMemo(() => {
    if (!evaluation) return 0;
    return (
      evaluation.taskTiers.filter((t) => !t.isOptimal).length +
      evaluation.agents.filter((a) => !a.isOptimal).length
    );
  }, [evaluation]);

  const agentsByTier = useMemo(() => {
    const map = new Map<string, AgentSettingEvaluation[]>();
    for (const agent of evaluation?.agents ?? []) {
      const list = map.get(agent.taskTier) ?? [];
      list.push(agent);
      map.set(agent.taskTier, list);
    }
    return map;
  }, [evaluation]);

  if (!evaluation) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Agent settings</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Could not load the agent settings evaluation. Ensure the questionnaire agents are seeded
          and an OpenAI provider is configured.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent settings</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Review each questionnaire agent&apos;s model, temperature and reasoning effort against
            the advisory baseline, see the cost trade-off, and apply recommended settings. Model
            recommendations update the shared task-tier default; temperature and effort apply
            per-agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={bulk}>
            <RefreshCw className={cn('mr-1 h-4 w-4', bulk && 'animate-spin')} /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => void handleApplyAll()}
            disabled={bulk || pendingCount === 0}
          >
            {bulk ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-4 w-4" />
            )}
            Apply all{pendingCount > 0 ? ` (${pendingCount})` : ''}
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Task-tier defaults</h2>
          <p className="text-muted-foreground text-sm">
            Shared model defaults every agent inherits unless overridden. Applying moves all agents
            on that tier.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {evaluation.taskTiers.map((tier) => (
            <TaskDefaultCard
              key={tier.tier}
              tier={tier}
              applying={applyingKey === `tier:${tier.tier}`}
              saved={savedKeys.has(`tier:${tier.tier}`)}
              onApply={() => void handleApplyTier(tier.tier, tier.recommendedModel)}
            />
          ))}
        </div>

        <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {evaluation.infraDefaults.map((infra) => (
            <span key={infra.tier}>
              <span className="capitalize">{infra.tier}</span>:{' '}
              <span className="font-mono">{infra.currentModel ?? 'unset'}</span>
              {!infra.isOptimal && (
                <>
                  {' → '}
                  <span className="font-mono text-green-700 dark:text-green-500">
                    {infra.recommendedModel}
                  </span>{' '}
                  (set via Settings → Default models)
                </>
              )}
            </span>
          ))}
        </div>
      </section>

      {TIER_ORDER.map((tier) => {
        const agents = agentsByTier.get(tier);
        if (!agents || agents.length === 0) return null;
        return (
          <section key={tier} className="space-y-3">
            <h2 className="text-lg font-semibold">{TIER_HEADINGS[tier]}</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <AgentSettingCard
                  key={agent.slug}
                  agent={agent}
                  applying={applyingKey === `agent:${agent.slug}`}
                  saved={savedKeys.has(`agent:${agent.slug}`)}
                  onApply={() => void handleApplyAgent(agent)}
                  onApplyPatch={(patch) => void handleApplyPatch(agent, patch)}
                />
              ))}
            </div>
          </section>
        );
      })}

      <footer className="text-muted-foreground text-xs">
        Evaluated {new Date(evaluation.generatedAt).toLocaleString()} · per-call costs are rough
        maxTokens-bounded estimates from blended ($/M) provider-model rates.
      </footer>
    </div>
  );
}
