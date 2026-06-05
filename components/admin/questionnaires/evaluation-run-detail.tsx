'use client';

/**
 * EvaluationRunDetail (F5.2) — read-only view of one persisted design-evaluation run.
 *
 * Renders the run header (status, judges run/requested, total findings) and then one
 * section per dimension, in dispatch order: the judge's score (or its diagnostic when it
 * failed), followed by that dimension's findings — each with its severity, the targeted
 * key, the proposed change, the rationale, and the offending quote when present. Purely
 * presentational; the accept / decline / edit / apply review queue is F5.3, so there are
 * no actions here yet.
 */

import { Badge } from '@/components/ui/badge';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';
import {
  findingSeverityBadge,
  runStatusBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';

export function EvaluationRunDetail({ run }: { run: EvaluationRunDetailView }) {
  const badge = runStatusBadge(run.status);

  // Findings arrive ordered by (dimension, ordinal); bucket them so each dimension section
  // can render its own without re-filtering the whole list per section.
  const byDimension = new Map<string, EvaluationFindingView[]>();
  for (const f of run.findings) {
    const list = byDimension.get(f.dimension) ?? [];
    list.push(f);
    byDimension.set(f.dimension, list);
  }

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

      {run.dimensionSummary.map((dim) => {
        const spec = EVALUATION_DIMENSION_SPECS[dim.dimension];
        const findings = byDimension.get(dim.dimension) ?? [];
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

            {!dim.diagnostic && findings.length === 0 && (
              <p className="text-muted-foreground text-sm italic">No issues raised.</p>
            )}

            <ul className="space-y-3">
              {findings.map((f) => {
                const sev = findingSeverityBadge(f.severity);
                return (
                  <li key={f.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={sev.variant} className="text-xs">
                        {sev.label}
                      </Badge>
                      <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{f.targetKey}</code>
                    </div>
                    <p className="mt-2 text-sm font-medium">{f.proposedChange}</p>
                    <p className="text-muted-foreground mt-1 text-sm">{f.rationale}</p>
                    {f.sourceQuote && (
                      <blockquote className="text-muted-foreground mt-2 border-l-2 pl-3 text-xs italic">
                        {f.sourceQuote}
                      </blockquote>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
