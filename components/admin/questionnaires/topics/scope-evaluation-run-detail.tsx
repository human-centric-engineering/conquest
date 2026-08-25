'use client';

/**
 * ScopeEvaluationRunDetail (F17.21) — one Conditional Topics evaluation run, with its review queue.
 *
 * Leaner than `EvaluationRunDetail` (F5.3) by design: four judges over a handful of topics/rules
 * is small enough to read as one list grouped by target (topic/rule/settings), so there is no
 * by-question/by-judge toggle — the two-view machinery F5.3 needed to tame dozens of questions
 * across seven judges would be over-built here.
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  SCOPE_EVALUATION_DIMENSION_SPECS,
  groupScopeFindingsByTarget,
  tallyScopeSeverities,
  type ScopeEvaluationDimension,
} from '@/lib/app/questionnaire/scope-evaluation';
import type {
  ScopeEvaluationFindingView,
  ScopeEvaluationRunDetail as ScopeEvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';
import { ScopeFindingReviewCard } from '@/components/admin/questionnaires/topics/scope-finding-review-card';
import {
  JudgeFailureIcon,
  RetryJudgeButton,
  judgeFailureReason,
} from '@/components/admin/questionnaires/evaluation-judge-failure';

interface Props {
  run: ScopeEvaluationRunDetailView;
  questionnaireId: string;
  versionId: string;
  canApply: boolean;
}

const KIND_LABEL: Record<string, string> = {
  settings: 'Settings',
  topic: 'Topic',
  rule: 'Rule',
  unknown: 'Target',
};

export function ScopeEvaluationRunDetail({ run, questionnaireId, versionId, canApply }: Props) {
  const [current, setCurrent] = useState(run);
  const [retrying, setRetrying] = useState<ScopeEvaluationDimension | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<number | null>(null);

  const severity = tallyScopeSeverities(current.findings);
  const reviewed = current.findings.filter((f) => f.status !== 'pending').length;
  const pending = current.findings.length - reviewed;
  const groups = groupScopeFindingsByTarget(current.findings);

  const stats: CqStat[] = [
    {
      label: 'Major',
      value: severity.major,
      accent: true,
      hint: severity.major > 0 ? `across ${groups.length} flagged item(s)` : 'nothing blocking',
    },
    { label: 'Minor', value: severity.minor },
    { label: 'Info', value: severity.info },
    {
      label: 'Reviewed',
      value: `${reviewed} / ${current.findings.length}`,
      hint: pending > 0 ? `${pending} still pending` : 'queue clear',
    },
  ];

  function updateFinding(
    next: ScopeEvaluationFindingView,
    meta?: { forked: boolean; versionNumber: number }
  ) {
    setCurrent((prev) => ({
      ...prev,
      findings: prev.findings.map((f) => (f.id === next.id ? next : f)),
    }));
    if (meta?.forked) setForkNotice(meta.versionNumber);
  }

  async function retryJudge(dimension: string) {
    const dim = dimension as ScopeEvaluationDimension;
    setRetrying(dim);
    setRetryError(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.versionScopeEvaluationRetryJudge(questionnaireId, versionId, run.id),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dimension: dim }),
        }
      );
      const body = await parseApiResponse<ScopeEvaluationRunDetailView>(res);
      if (!res.ok || !body.success) {
        throw new Error(!body.success ? body.error.message : 'Retry failed');
      }
      setCurrent(body.data);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Could not retry the judge.');
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="space-y-4">
      {forkNotice !== null && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          Applying a suggestion forked this into a new draft (v{forkNotice}) — further applies from
          this run land there too.
        </div>
      )}

      <CqStatTiles stats={stats} />

      <div className="cq-rise bg-card rounded-xl border p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">Judges</h3>
          <span className="text-muted-foreground text-xs tabular-nums">
            {current.dimensionsRun}/{current.dimensionsRequested} ran
          </span>
          {current.dimensionsFailed > 0 && (
            <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium tabular-nums">
              <JudgeFailureIcon />
              {current.dimensionsFailed} failed
            </span>
          )}
        </div>
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))] gap-2">
          {current.dimensionSummary.map((dim) => {
            const spec = SCOPE_EVALUATION_DIMENSION_SPECS[dim.dimension];
            const failed = dim.diagnostic !== null;
            return (
              <div
                key={dim.dimension}
                className={`rounded-lg border p-2.5 ${failed ? 'border-destructive/40 bg-destructive/5' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-xs font-medium">
                    {failed && <JudgeFailureIcon />}
                    <span className="truncate">{spec.label.replace(/ Judge$/, '')}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {dim.score !== null ? dim.score.toFixed(2) : '—'}
                  </span>
                </div>
                {failed ? (
                  <div className="mt-1.5 space-y-1.5">
                    <Badge variant="destructive" className="text-[10px]">
                      Failed
                    </Badge>
                    <p
                      className="text-destructive text-[11px] leading-snug"
                      title={dim.diagnostic ?? undefined}
                    >
                      {judgeFailureReason(dim.diagnostic ?? '')}
                    </p>
                    <RetryJudgeButton
                      dimension={dim.dimension}
                      busy={retrying === dim.dimension}
                      disabled={retrying !== null}
                      onRetry={(d) => void retryJudge(d)}
                    />
                  </div>
                ) : (
                  <div className="text-muted-foreground mt-1.5 text-[11px] tabular-nums">
                    {dim.findingCount === 0 ? 'clean' : `${dim.findingCount} finding(s)`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {retryError && (
          <p role="alert" className="text-destructive mt-2 text-xs">
            Retry failed: {retryError}
          </p>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">This run raised no findings.</p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.key} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs font-medium">
                  {KIND_LABEL[group.kind] ?? 'Target'}
                </span>
                <span className="text-sm font-medium">{group.label}</span>
                {group.removed && (
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    <AlertTriangle className="h-3 w-3" /> removed since this run
                  </span>
                )}
              </div>
              <ul className="space-y-2">
                {group.findings.map((finding) => (
                  <ScopeFindingReviewCard
                    key={finding.id}
                    finding={finding}
                    questionnaireId={questionnaireId}
                    versionId={versionId}
                    runId={run.id}
                    canApply={canApply}
                    onUpdate={updateFinding}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
