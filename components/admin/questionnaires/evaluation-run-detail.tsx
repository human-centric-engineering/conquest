'use client';

/**
 * EvaluationRunDetail (F5.2 read view → F5.3 review queue).
 *
 * Renders the run header and one section per dimension (the judge's score or diagnostic, then its
 * findings), now as an **interactive review queue**: each finding can be accepted, declined,
 * edited, or applied (see `FindingReviewCard`). Findings live in component state so an action
 * updates the card in place without a full reload. When an apply forks a launched version, the
 * returned meta surfaces a banner pointing at the new draft (subsequent applies from this run
 * converge on that same draft server-side). A status filter narrows the queue.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  EVALUATION_DIMENSION_SPECS,
  FINDING_REVIEW_STATUSES,
  type FindingReviewStatus,
} from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { FindingReviewCard } from '@/components/admin/questionnaires/evaluation-finding-review';

interface ForkNotice {
  versionId: string;
  versionNumber: number;
}

interface Props {
  run: EvaluationRunDetailView;
  questionnaireId: string;
  versionId: string;
  canApply: boolean;
}

const STATUS_FILTERS: ('all' | FindingReviewStatus)[] = ['all', ...FINDING_REVIEW_STATUSES];

export function EvaluationRunDetail({ run, questionnaireId, versionId, canApply }: Props) {
  const badge = runStatusBadge(run.status);
  const [findings, setFindings] = useState<EvaluationFindingView[]>(run.findings);
  const [fork, setFork] = useState<ForkNotice | null>(null);
  const [filter, setFilter] = useState<'all' | FindingReviewStatus>('all');

  function handleUpdate(
    next: EvaluationFindingView,
    meta?: { forked: boolean; versionId: string; versionNumber: number }
  ) {
    setFindings((prev) => prev.map((f) => (f.id === next.id ? next : f)));
    if (meta?.forked) setFork({ versionId: meta.versionId, versionNumber: meta.versionNumber });
  }

  const visible = useMemo(
    () => (filter === 'all' ? findings : findings.filter((f) => f.status === filter)),
    [findings, filter]
  );

  // Bucket the (already dimension/ordinal-ordered) visible findings per dimension.
  const byDimension = useMemo(() => {
    const map = new Map<string, EvaluationFindingView[]>();
    for (const f of visible) {
      const list = map.get(f.dimension) ?? [];
      list.push(f);
      map.set(f.dimension, list);
    }
    return map;
  }, [visible]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-muted-foreground text-sm">
          {run.dimensionsRun}/{run.dimensionsRequested} judges ran
          {run.dimensionsFailed > 0 ? ` · ${run.dimensionsFailed} failed` : ''} ·{' '}
          {run.totalFindings} finding{run.totalFindings === 1 ? '' : 's'}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>

      {fork && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm">
          A new draft <strong>v{fork.versionNumber}</strong> was created from this launched version.
          Applied suggestions land there.{' '}
          <Link
            href={`/admin/questionnaires/${questionnaireId}/v/${fork.versionId}/structure`}
            className="underline"
          >
            Open the draft →
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={filter === s ? 'secondary' : 'ghost'}
            onClick={() => setFilter(s)}
            className="text-xs capitalize"
          >
            {s}
          </Button>
        ))}
      </div>

      {run.dimensionSummary.map((dim) => {
        const spec = EVALUATION_DIMENSION_SPECS[dim.dimension];
        const dimFindings = byDimension.get(dim.dimension) ?? [];
        // Hide a clean dimension entirely once a filter is active and it has nothing to show.
        if (filter !== 'all' && dimFindings.length === 0) return null;
        return (
          <section key={dim.dimension} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold">{spec.label}</h3>
              {dim.diagnostic ? (
                <Badge variant="outline" className="text-xs">
                  failed · {dim.diagnostic}
                </Badge>
              ) : (
                <span className="text-muted-foreground text-xs tabular-nums">
                  score {dim.score !== null ? dim.score.toFixed(2) : '—'} · {dim.findingCount}{' '}
                  finding{dim.findingCount === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {filter === 'all' && !dim.diagnostic && dimFindings.length === 0 && (
              <p className="text-muted-foreground text-sm italic">No issues raised.</p>
            )}

            <ul className="space-y-3">
              {dimFindings.map((f) => (
                <FindingReviewCard
                  key={f.id}
                  finding={f}
                  questionnaireId={questionnaireId}
                  versionId={versionId}
                  runId={run.id}
                  canApply={canApply}
                  onUpdate={handleUpdate}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
