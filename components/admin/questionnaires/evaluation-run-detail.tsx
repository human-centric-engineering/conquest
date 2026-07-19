'use client';

/**
 * EvaluationRunDetail (F5.2 read view → F5.3 review queue → question-centric view).
 *
 * The shell for one run: a headline band, a sticky control row, and the active view mode.
 *
 * Two modes over the same findings and the same review actions:
 *  - **By question** (default) — one card per target, every judge's findings about it together.
 *    This is the shape of the admin's actual job (fix the questionnaire) and the only view that
 *    shows cross-judge consensus.
 *  - **By judge** — the original per-dimension sections, still the right view for "how did the
 *    Clarity judge do?" and for reading a dimension's score in context.
 *
 * Three filters compose across both modes (status ∧ severity ∧ judge). Severity filtering is new:
 * `severity` used to be display-only, which left "show me what blocks launch" — the whole point of
 * the `major` level — impossible to ask.
 *
 * Findings live in component state so a review action updates its card in place. When an apply
 * forks a launched version the returned meta raises a banner pointing at the new draft.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  EVALUATION_DIMENSION_SPECS,
  FINDING_REVIEW_STATUSES,
  FINDING_SEVERITIES,
  type EvaluationDimension,
  type FindingReviewStatus,
  type FindingSeverity,
} from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';
import { runStatusBadge } from '@/components/admin/questionnaires/evaluation-status-badge';
import { FindingReviewCard } from '@/components/admin/questionnaires/evaluation-finding-review';
import { EvaluationRunHeadline } from '@/components/admin/questionnaires/evaluation-run-headline';
import { EvaluationByQuestion } from '@/components/admin/questionnaires/evaluation-by-question';
import {
  groupFindingsByTarget,
  GROUP_SORTS,
  GROUP_SORT_LABELS,
  type GroupSort,
} from '@/components/admin/questionnaires/evaluation-grouping';

interface ForkNotice {
  versionId: string;
  versionNumber: number;
}

interface Props {
  run: EvaluationRunDetailView;
  questionnaireId: string;
  versionId: string;
  canApply: boolean;
  /** Whether the version has data slots — drives the "slot the new question" checkbox on add_question. */
  dataSlotsAvailable?: boolean;
}

type ViewMode = 'question' | 'judge';

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'question', label: 'By question' },
  { value: 'judge', label: 'By judge' },
];

const STATUS_FILTERS: ('all' | FindingReviewStatus)[] = ['all', ...FINDING_REVIEW_STATUSES];
const SEVERITY_FILTERS: ('all' | FindingSeverity)[] = ['all', ...FINDING_SEVERITIES];

export function EvaluationRunDetail({
  run,
  questionnaireId,
  versionId,
  canApply,
  dataSlotsAvailable = false,
}: Props) {
  const badge = runStatusBadge(run.status);
  const [findings, setFindings] = useState<EvaluationFindingView[]>(run.findings);
  const [fork, setFork] = useState<ForkNotice | null>(null);

  const [mode, setMode] = useState<ViewMode>('question');
  const [sort, setSort] = useState<GroupSort>('natural');
  const [status, setStatus] = useState<'all' | FindingReviewStatus>('all');
  const [severity, setSeverity] = useState<'all' | FindingSeverity>('all');
  const [dimension, setDimension] = useState<EvaluationDimension | null>(null);

  function handleUpdate(
    next: EvaluationFindingView,
    meta?: { forked: boolean; versionId: string; versionNumber: number }
  ) {
    setFindings((prev) => prev.map((f) => (f.id === next.id ? next : f)));
    if (meta?.forked) setFork({ versionId: meta.versionId, versionNumber: meta.versionNumber });
  }

  const visible = useMemo(
    () =>
      findings.filter(
        (f) =>
          (status === 'all' || f.status === status) &&
          (severity === 'all' || f.severity === severity) &&
          (dimension === null || f.dimension === dimension)
      ),
    [findings, status, severity, dimension]
  );

  const groups = useMemo(() => groupFindingsByTarget(visible, sort), [visible, sort]);

  // The headline describes the *run*, so it counts every finding regardless of filter. Only the
  // number of distinct targets is needed, so count keys directly rather than grouping and sorting.
  const targetCount = useMemo(
    () => new Set(findings.map((f) => f.target?.key ?? f.targetKey)).size,
    [findings]
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

  const filtered = status !== 'all' || severity !== 'all' || dimension !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-muted-foreground text-sm">
          {run.totalFindings} finding{run.totalFindings === 1 ? '' : 's'} from {run.dimensionsRun}{' '}
          judge{run.dimensionsRun === 1 ? '' : 's'}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>

      <EvaluationRunHeadline
        dimensionSummary={run.dimensionSummary}
        findings={findings}
        dimensionsRun={run.dimensionsRun}
        dimensionsRequested={run.dimensionsRequested}
        dimensionsFailed={run.dimensionsFailed}
        targetCount={targetCount}
        activeDimension={dimension}
        onDimensionChange={setDimension}
      />

      {fork && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
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

      {/* Sticky so the filters stay reachable while working down a long queue. */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-1 space-y-2 px-1 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-muted inline-flex items-center rounded-lg p-1">
            {VIEW_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  mode === m.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'question' && (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground font-medium">Sort</span>
              <select
                value={sort}
                aria-label="Sort questions"
                onChange={(e) => setSort(e.target.value as GroupSort)}
                className="bg-background rounded border px-2 py-1 text-sm"
              >
                {GROUP_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {GROUP_SORT_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          )}

          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {visible.length} of {findings.length} shown
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground mr-1 text-xs font-medium">Status</span>
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={status === s ? 'secondary' : 'ghost'}
                onClick={() => setStatus(s)}
                aria-pressed={status === s}
                className="text-xs capitalize"
              >
                {s}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground mr-1 text-xs font-medium">Severity</span>
            {SEVERITY_FILTERS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={severity === s ? 'secondary' : 'ghost'}
                onClick={() => setSeverity(s)}
                aria-pressed={severity === s}
                className="text-xs capitalize"
              >
                {s}
              </Button>
            ))}
          </div>

          {dimension && (
            <Badge variant="outline" className="gap-1 text-xs">
              {EVALUATION_DIMENSION_SPECS[dimension].label}
              <button
                type="button"
                onClick={() => setDimension(null)}
                aria-label="Clear judge filter"
                className="hover:text-foreground"
              >
                ×
              </button>
            </Badge>
          )}
        </div>
      </div>

      {mode === 'question' ? (
        <EvaluationByQuestion
          groups={groups}
          questionnaireId={questionnaireId}
          versionId={versionId}
          runId={run.id}
          canApply={canApply}
          dataSlotsAvailable={dataSlotsAvailable}
          onUpdate={handleUpdate}
        />
      ) : (
        <div className="space-y-6">
          {run.dimensionSummary.map((dim) => {
            const spec = EVALUATION_DIMENSION_SPECS[dim.dimension];
            const dimFindings = byDimension.get(dim.dimension) ?? [];
            // Hide a clean dimension entirely once a filter is active and it has nothing to show.
            if (filtered && dimFindings.length === 0) return null;
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

                {!filtered && !dim.diagnostic && dimFindings.length === 0 && (
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
                      dataSlotsAvailable={dataSlotsAvailable}
                      onUpdate={handleUpdate}
                    />
                  ))}
                </ul>
              </section>
            );
          })}

          {filtered && visible.length === 0 && (
            <p className="text-muted-foreground rounded-xl border border-dashed py-10 text-center text-sm">
              No findings match these filters.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
