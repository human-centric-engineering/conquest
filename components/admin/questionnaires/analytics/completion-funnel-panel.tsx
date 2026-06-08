'use client';

/**
 * Completion funnel panel (F8.1): invited → opened → started → completed.
 *
 * Each stage is a horizontal bar widthed by its retention from the first stage,
 * annotated with the count, step conversion, and absolute drop-off. Anonymous
 * (un-invited) sessions are shown separately since they don't pass through the
 * invite stages.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CompletionFunnelResult, FunnelStage } from '@/lib/app/questionnaire/analytics';

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function StageBar({ stage, isFirst }: { stage: FunnelStage; isFirst: boolean }) {
  const width = Math.max(2, stage.retention * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{stage.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {stage.count} · {pct(stage.retention)} of invited
        </span>
      </div>
      <div className="bg-muted h-7 w-full overflow-hidden rounded">
        <div
          className="bg-primary/70 flex h-full items-center justify-end rounded pr-2 text-xs font-medium text-white"
          style={{ width: `${width}%` }}
        >
          {stage.count > 0 ? stage.count : ''}
        </div>
      </div>
      {!isFirst && (
        <p className="text-muted-foreground text-xs">
          {pct(stage.conversionFromPrev)} from previous · {stage.dropoff} dropped
        </p>
      )}
    </div>
  );
}

export function CompletionFunnelPanel({ data }: { data: CompletionFunnelResult | null }) {
  if (!data) {
    return <p className="text-muted-foreground text-sm">Funnel data could not be loaded.</p>;
  }

  const invited = data.stages[0]?.count ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Invitation funnel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {invited === 0 ? (
            <p className="text-muted-foreground text-sm italic">
              No invitations sent in this window.
            </p>
          ) : (
            data.stages.map((stage, i) => (
              <StageBar key={stage.key} stage={stage} isFirst={i === 0} />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anonymous sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Public-link respondents with no invitation. They enter at “started”, so they sit outside
            the invite funnel.
          </p>
          <div className="flex gap-6">
            <div>
              <div className="text-2xl font-semibold tabular-nums">{data.anonymous.started}</div>
              <div className="text-muted-foreground text-xs">started</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{data.anonymous.completed}</div>
              <div className="text-muted-foreground text-xs">completed</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
