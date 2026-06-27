'use client';

/**
 * One task-tier default card (reasoning / chat / routing). Shows the current
 * shared default model vs the recommended OpenAI model with a $/M comparison, and
 * an Apply button that PATCHes `AiOrchestrationSettings.defaultModels[tier]` (so
 * every inheriting agent moves together). Presentational — the panel owns state
 * and the apply handler.
 */

import { ArrowRight, Check, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { TaskTierEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import { formatPerMillion } from '@/components/admin/questionnaires/agent-settings/format';

interface TaskDefaultCardProps {
  tier: TaskTierEvaluation;
  applying: boolean;
  saved: boolean;
  onApply: () => void;
}

export function TaskDefaultCard({ tier, applying, saved, onApply }: TaskDefaultCardProps) {
  return (
    <Card className={cn(tier.isOptimal && 'border-green-600/40')}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{tier.label}</CardTitle>
        {tier.isOptimal ? (
          <Badge variant="outline" className="border-green-600/50 text-green-600">
            <Check className="mr-1 h-3 w-3" /> Optimal
          </Badge>
        ) : (
          <Badge variant="secondary">Recommendation</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <div className="flex flex-col">
            <span className="font-mono">{tier.currentModel ?? 'unset'}</span>
            <span className="text-muted-foreground text-xs">
              {formatPerMillion(tier.currentModelPerMillionUsd)}
            </span>
          </div>
          {!tier.isOptimal && (
            <>
              <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
              <div className="flex flex-col">
                <span className="font-mono text-green-700 dark:text-green-500">
                  {tier.recommendedModel}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatPerMillion(tier.recommendedModelPerMillionUsd)}
                </span>
              </div>
            </>
          )}
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{tier.rationale}</p>

        <div className="flex items-center justify-end gap-2">
          {saved && (
            <span className="flex items-center text-xs text-green-600">
              <Check className="mr-1 h-3 w-3" /> Saved
            </span>
          )}
          <Button size="sm" onClick={onApply} disabled={tier.isOptimal || applying}>
            {applying && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {tier.isOptimal ? 'Up to date' : 'Apply'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
