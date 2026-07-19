'use client';

/**
 * Headline figures for one evaluation run.
 *
 * The run header used to be a single line of prose ("5/7 judges ran · 12 findings"), which
 * answers neither of the two questions an admin opens this page with: *how bad is it* and
 * *which judge is unhappy*. This band answers both above the fold —
 *
 *  - severity tiles (major / minor / info) plus review progress, via the shared `CqStatTiles`;
 *  - a per-judge strip carrying each dimension's score and its severity split.
 *
 * The judge cells are **buttons**: clicking one filters the queue below to that dimension, so the
 * summary is a way into the work rather than decoration. Judges that failed are rendered but not
 * clickable — they have no findings to filter to.
 *
 * Honesty: when judges failed, the severity totals are an undercount and the band says so. A
 * summary that quietly omits the judges that never ran is worse than no summary.
 */

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import {
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
} from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationDimensionSummary,
  EvaluationFindingView,
} from '@/lib/app/questionnaire/views';
import {
  tallySeverities,
  type SeverityCounts,
} from '@/components/admin/questionnaires/evaluation-grouping';

/**
 * Severity → bar fill. An ordinal 3-step ramp (alarm → accent → quiet) built from existing
 * theme tokens so it tracks light/dark without a second palette. Never the sole signal: every
 * bar is paired with a text tally.
 */
const SEVERITY_FILL: Record<keyof Omit<SeverityCounts, 'total'>, string> = {
  major: 'bg-destructive',
  minor: 'bg-[color:var(--cq-accent)]',
  info: 'bg-muted-foreground/40',
};

const SEVERITY_ORDER = ['major', 'minor', 'info'] as const;

/** A stacked severity bar for one judge. Renders nothing when the judge raised no findings. */
function SeverityBar({ counts }: { counts: SeverityCounts }) {
  if (counts.total === 0) return null;
  const label = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  return (
    <div
      className="bg-muted mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={`Severity split: ${label}`}
    >
      {SEVERITY_ORDER.map((s) =>
        counts[s] > 0 ? (
          <div
            key={s}
            className={SEVERITY_FILL[s]}
            style={{ width: `${(counts[s] / counts.total) * 100}%` }}
          />
        ) : null
      )}
    </div>
  );
}

interface Props {
  dimensionSummary: EvaluationDimensionSummary[];
  /** All findings on the run (unfiltered) — the headline describes the run, not the filter. */
  findings: EvaluationFindingView[];
  dimensionsRun: number;
  dimensionsRequested: number;
  dimensionsFailed: number;
  /** Number of distinct targets the findings touch — the "across N" hint on the major tile. */
  targetCount: number;
  /** Active dimension filter, or `null` for "all judges". */
  activeDimension: EvaluationDimension | null;
  onDimensionChange: (dimension: EvaluationDimension | null) => void;
}

export function EvaluationRunHeadline({
  dimensionSummary,
  findings,
  dimensionsRun,
  dimensionsRequested,
  dimensionsFailed,
  targetCount,
  activeDimension,
  onDimensionChange,
}: Props) {
  const severity = tallySeverities(findings);

  const reviewed = findings.filter((f) => f.status !== 'pending').length;
  const pending = findings.length - reviewed;
  const staleCount = findings.filter((f) => f.stale).length;

  // Per-dimension severity splits, computed once for the strip.
  const byDimension = new Map<string, SeverityCounts>();
  for (const dim of dimensionSummary) {
    byDimension.set(
      dim.dimension,
      tallySeverities(findings.filter((f) => f.dimension === dim.dimension))
    );
  }

  const stats: CqStat[] = [
    {
      label: 'Major',
      value: severity.major,
      accent: true,
      hint:
        severity.major > 0
          ? `across ${targetCount} flagged item${targetCount === 1 ? '' : 's'}`
          : 'nothing blocking launch',
    },
    { label: 'Minor', value: severity.minor },
    { label: 'Info', value: severity.info },
    {
      label: 'Reviewed',
      value: `${reviewed} / ${findings.length}`,
      hint: pending > 0 ? `${pending} still pending` : 'queue clear',
    },
  ];

  return (
    <div className="space-y-3">
      <CqStatTiles stats={stats} />

      <div className="cq-rise bg-card rounded-xl border p-4" style={{ animationDelay: '240ms' }}>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">Judges</h3>
          <span className="text-muted-foreground text-xs tabular-nums">
            {dimensionsRun}/{dimensionsRequested} ran
            {dimensionsFailed > 0 ? ` · ${dimensionsFailed} failed` : ''}
          </span>
          {activeDimension && (
            <button
              type="button"
              onClick={() => onDimensionChange(null)}
              className="text-muted-foreground hover:text-foreground ml-auto text-xs underline"
            >
              Clear judge filter
            </button>
          )}
        </div>

        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))] gap-2">
          {dimensionSummary.map((dim) => {
            const spec = EVALUATION_DIMENSION_SPECS[dim.dimension];
            const counts = byDimension.get(dim.dimension) ?? {
              major: 0,
              minor: 0,
              info: 0,
              total: 0,
            };
            const active = activeDimension === dim.dimension;
            const failed = dim.diagnostic !== null;

            // A failed judge has nothing to filter to, so it is a plain cell rather than a button.
            const Cell = failed ? 'div' : 'button';

            return (
              <Cell
                key={dim.dimension}
                {...(failed
                  ? {}
                  : {
                      type: 'button' as const,
                      onClick: () => onDimensionChange(active ? null : dim.dimension),
                      'aria-pressed': active,
                      // The cell's visible text is terse ("Clarity 0.60"); spell out what
                      // activating it does.
                      'aria-label': `${active ? 'Clear filter' : 'Filter'} to ${spec.label}`,
                    })}
                className={cn(
                  'rounded-lg border p-2.5 text-left transition-colors',
                  failed && 'border-dashed opacity-70',
                  !failed && 'cursor-pointer hover:border-[color:var(--cq-accent)]',
                  active && 'border-[color:var(--cq-accent)] bg-[color:var(--cq-accent-muted)]'
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  {/* Specs label them "Clarity Judge"; the heading above already says "Judges". */}
                  <span className="truncate text-xs font-medium">
                    {spec.label.replace(/ Judge$/, '')}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {dim.score !== null ? dim.score.toFixed(2) : '—'}
                  </span>
                </div>

                {failed ? (
                  <Badge variant="outline" className="mt-1.5 text-[10px]">
                    failed
                  </Badge>
                ) : (
                  <>
                    <SeverityBar counts={counts} />
                    <div className="text-muted-foreground mt-1.5 text-[11px] tabular-nums">
                      {counts.total === 0
                        ? 'clean'
                        : `${counts.total} finding${counts.total === 1 ? '' : 's'}`}
                      {counts.major > 0 ? ` · ${counts.major} major` : ''}
                    </div>
                  </>
                )}
              </Cell>
            );
          })}
        </div>

        {(dimensionsFailed > 0 || staleCount > 0) && (
          <p className="text-muted-foreground mt-3 text-xs">
            {dimensionsFailed > 0 &&
              `${dimensionsFailed} judge${dimensionsFailed === 1 ? '' : 's'} did not run — these totals are an undercount. `}
            {staleCount > 0 &&
              `${staleCount} finding${staleCount === 1 ? '' : 's'} went stale as the structure changed; re-run to refresh.`}
          </p>
        )}
      </div>
    </div>
  );
}
