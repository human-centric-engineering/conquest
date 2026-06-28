'use client';

/**
 * One agent card in the Agent Settings Evaluation grid. Compares the agent's
 * current resolved model / temperature / maxTokens / reasoning effort against the
 * advisory recommendation, shows the per-call cost delta and real 30-day spend,
 * and flags the gpt-5-family "temperature ignored" caveat. The Apply button
 * PATCHes the agent's per-agent fields (and, for outliers, the override model).
 *
 * Presentational — the panel owns state and the apply handler.
 */

import { useCallback, useState } from 'react';
import { ArrowRight, Check, Loader2, Sparkles, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AgentSettingEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import type { AgentSettingsExplanation } from '@/lib/app/questionnaire/agent-advisory/explain-schema';
import {
  formatPerMillion,
  formatPct,
  formatTemperature,
  formatUsd,
} from '@/components/admin/questionnaires/agent-settings/format';

interface AgentSettingCardProps {
  agent: AgentSettingEvaluation;
  applying: boolean;
  saved: boolean;
  onApply: () => void;
  /** Apply an arbitrary per-agent patch (used by the AI suggestion); panel-owned. */
  onApplyPatch: (patch: Record<string, unknown>) => void;
}

/** A current → recommended comparison row; highlights the recommended value when it differs. */
function Row({
  label,
  current,
  recommended,
  changed,
  caveat,
}: {
  label: string;
  current: string;
  recommended: string;
  changed: boolean;
  caveat?: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-2 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono">{current}</span>
        {changed && (
          <>
            <ArrowRight className="text-muted-foreground h-3 w-3 shrink-0 self-center" />
            <span className="font-mono text-green-700 dark:text-green-500">{recommended}</span>
          </>
        )}
        {caveat && (
          <span className="inline-flex items-center text-xs text-amber-600 dark:text-amber-500">
            <TriangleAlert className="mr-1 h-3 w-3" />
            {caveat}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentSettingCard({
  agent,
  applying,
  saved,
  onApply,
  onApplyPatch,
}: AgentSettingCardProps) {
  const { current, recommended, cost, actuals, flags } = agent;

  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<AgentSettingsExplanation | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);

  const handleExplain = useCallback(async () => {
    setExplaining(true);
    setExplainError(null);
    try {
      const result = await apiClient.post<AgentSettingsExplanation>(
        API.APP.QUESTIONNAIRES.agentSettingsExplain,
        { body: { slug: agent.slug } }
      );
      setExplanation(result);
    } catch (err) {
      setExplainError(
        err instanceof APIClientError ? err.message : 'Could not generate an AI explanation.'
      );
    } finally {
      setExplaining(false);
    }
  }, [agent.slug]);

  const applyAiSuggestion = useCallback(() => {
    const s = explanation?.suggestion;
    if (!s) return;
    const patch: Record<string, unknown> = {};
    if (s.model !== null) patch.model = s.model;
    if (s.temperature !== null) patch.temperature = s.temperature;
    if (s.maxTokens !== null) patch.maxTokens = s.maxTokens;
    if (s.reasoningEffort !== null) patch.reasoningEffort = s.reasoningEffort;
    if (Object.keys(patch).length > 0) onApplyPatch(patch);
  }, [explanation, onApplyPatch]);

  const modelChanged = (current.resolvedModel ?? null) !== recommended.model;
  const tempChanged = current.temperature !== recommended.temperature;
  const maxTokensChanged = current.maxTokens !== recommended.maxTokens;
  const effortChanged = (current.reasoningEffort ?? null) !== (recommended.reasoningEffort ?? null);

  const cheaper = cost.deltaPerCallUsd !== null && cost.deltaPerCallUsd < 0;
  const pricier = cost.deltaPerCallUsd !== null && cost.deltaPerCallUsd > 0;

  return (
    <Card className={cn('flex flex-col', agent.isOptimal && 'border-green-600/40')}>
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{agent.label}</h3>
            <p className="text-muted-foreground truncate text-xs">{agent.role}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant="outline" className="capitalize">
              {agent.taskTier}
            </Badge>
            {agent.isOptimal && (
              <Badge variant="outline" className="border-green-600/50 text-green-600">
                <Check className="mr-1 h-3 w-3" /> Optimal
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="space-y-1.5">
          <Row
            label="Model"
            current={current.resolvedModel ?? 'unresolved'}
            recommended={recommended.model}
            changed={modelChanged}
            caveat={
              recommended.isOverride && modelChanged
                ? 'per-agent override'
                : flags.modelUnresolved
                  ? 'tier default unset'
                  : undefined
            }
          />
          <Row
            label="Temperature"
            current={formatTemperature(current.temperature)}
            recommended={formatTemperature(recommended.temperature)}
            changed={tempChanged}
            caveat={flags.temperatureIgnored ? 'ignored by this model' : undefined}
          />
          <Row
            label="Max tokens"
            current={String(current.maxTokens)}
            recommended={String(recommended.maxTokens)}
            changed={maxTokensChanged}
          />
          <Row
            label="Effort"
            current={current.reasoningEffort ?? 'none'}
            recommended={recommended.reasoningEffort ?? 'none'}
            changed={effortChanged}
          />
        </div>

        <div className="bg-muted/40 grid grid-cols-2 gap-2 rounded-md p-2 text-xs">
          <div>
            <div className="text-muted-foreground">Cost / call (est.)</div>
            <div className="flex items-center gap-1">
              <span className="font-mono">{formatUsd(cost.currentEstPerCallUsd)}</span>
              {(cheaper || pricier) && (
                <>
                  <ArrowRight className="h-3 w-3" />
                  <span
                    className={cn(
                      'font-mono',
                      cheaper && 'text-green-600',
                      pricier && 'text-amber-600'
                    )}
                  >
                    {formatUsd(cost.recommendedEstPerCallUsd)}
                  </span>
                  <span className={cn(cheaper && 'text-green-600', pricier && 'text-amber-600')}>
                    ({formatPct(cost.deltaPct)})
                  </span>
                </>
              )}
            </div>
            <div className="text-muted-foreground mt-0.5">
              {formatPerMillion(cost.currentModelPerMillionUsd)} →{' '}
              {formatPerMillion(cost.recommendedModelPerMillionUsd)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Spend ({actuals.windowDays}d)</div>
            <div className="font-mono">{formatUsd(actuals.spendUsd)}</div>
            {actuals.calls !== null && (
              <div className="text-muted-foreground mt-0.5">{actuals.calls} calls</div>
            )}
          </div>
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{agent.rationale}</p>

        {explainError && <p className="text-xs text-red-600 dark:text-red-400">{explainError}</p>}

        {explanation && (
          <div className="bg-muted/30 space-y-2 rounded-md border p-2 text-xs">
            <div className="flex items-center gap-1 font-medium">
              <Sparkles className="h-3 w-3" /> AI Advisory
            </div>
            <p className="text-muted-foreground leading-relaxed">{explanation.narrative}</p>
            {explanation.suggestion && (
              <div className="space-y-1 border-t pt-2">
                <p className="text-muted-foreground leading-relaxed">
                  <span className="text-foreground font-medium">Suggestion: </span>
                  {explanation.suggestion.rationale}
                </p>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={applyAiSuggestion}
                    disabled={applying}
                  >
                    {applying && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    Apply AI suggestion
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-auto flex items-center justify-end gap-2 pt-1">
          {saved && (
            <span className="flex items-center text-xs text-green-600">
              <Check className="mr-1 h-3 w-3" /> Saved
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleExplain()}
            disabled={explaining}
          >
            {explaining ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            AI Advisory
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onApply}
            disabled={agent.isOptimal || applying}
          >
            {applying && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {agent.isOptimal ? 'Up to date' : 'Accept recommended'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
