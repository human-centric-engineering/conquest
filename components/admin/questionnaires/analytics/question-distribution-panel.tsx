'use client';

/**
 * Per-question distribution panel (F8.1).
 *
 * One card per question, with a type-appropriate breakdown rendered as lightweight
 * CSS bars (no chart lib instance per question — there can be many). Free-text
 * questions show only response rate / confidence / provenance; their answer values
 * are never rendered (PII-safe by design).
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TagChip } from '@/components/admin/questionnaires/tag-chip';
import { QUESTION_TYPE_LABELS } from '@/lib/app/questionnaire/types';
// Import the threshold from the pure `privacy` leaf, not the barrel — the barrel
// re-exports the Prisma-coupled aggregators, which must not enter this client bundle.
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type {
  DistributionDetail,
  QuestionDistribution,
  QuestionDistributionsResult,
} from '@/lib/app/questionnaire/analytics';

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function confidenceLabel(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(0)}%`;
}

/** A labelled horizontal bar: `label …… count` with a fill proportional to `max`. */
function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  const width = max > 0 ? Math.max(2, (count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-40 shrink-0 truncate" title={label}>
        {label}
      </span>
      <div className="bg-muted relative h-4 flex-1 overflow-hidden rounded">
        <div className="bg-primary/70 h-full rounded" style={{ width: `${width}%` }} />
      </div>
      <span className="text-muted-foreground w-10 shrink-0 text-right tabular-nums">{count}</span>
    </div>
  );
}

function DetailBody({ detail }: { detail: DistributionDetail }) {
  switch (detail.kind) {
    case 'free_text':
      return (
        <p className="text-muted-foreground text-sm italic">
          Free-text responses — values are not shown. See response rate and confidence above.
        </p>
      );

    case 'suppressed':
      return (
        <p className="text-muted-foreground text-sm italic">
          Hidden to protect respondent privacy (small sample).
        </p>
      );

    case 'choice': {
      const max = Math.max(1, ...detail.buckets.map((b) => b.count));
      return (
        <div className="space-y-1.5">
          {detail.buckets.map((b) => (
            <BarRow key={b.value} label={b.label} count={b.count} max={max} />
          ))}
          {detail.otherCount > 0 && (
            <BarRow label="Other / unlisted" count={detail.otherCount} max={max} />
          )}
        </div>
      );
    }

    case 'likert': {
      const max = Math.max(1, ...detail.buckets.map((b) => b.count));
      return (
        <div className="space-y-1.5">
          {detail.buckets.map((b) => (
            <BarRow key={b.value} label={b.label} count={b.count} max={max} />
          ))}
          {detail.mean != null && (
            <p className="text-muted-foreground pt-1 text-xs">Mean: {detail.mean.toFixed(2)}</p>
          )}
        </div>
      );
    }

    case 'numeric': {
      if (!detail.summary) {
        return <p className="text-muted-foreground text-sm italic">No numeric answers yet.</p>;
      }
      const { summary, histogram } = detail;
      const max = Math.max(1, ...histogram.map((b) => b.count));
      return (
        <div className="space-y-2">
          <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <span>min {summary.min}</span>
            <span>max {summary.max}</span>
            <span>mean {summary.mean.toFixed(1)}</span>
            <span>median {summary.median}</span>
          </div>
          <div className="space-y-1.5">
            {histogram.map((b) => (
              <BarRow key={b.label} label={b.label} count={b.count} max={max} />
            ))}
          </div>
        </div>
      );
    }

    case 'boolean': {
      const max = Math.max(1, detail.trueCount, detail.falseCount);
      return (
        <div className="space-y-1.5">
          <BarRow label={detail.trueLabel} count={detail.trueCount} max={max} />
          <BarRow label={detail.falseLabel} count={detail.falseCount} max={max} />
        </div>
      );
    }

    case 'date': {
      if (detail.buckets.length === 0) {
        return <p className="text-muted-foreground text-sm italic">No date answers yet.</p>;
      }
      const max = Math.max(1, ...detail.buckets.map((b) => b.count));
      return (
        <div className="space-y-1.5">
          {detail.buckets.map((b) => (
            <BarRow key={b.label} label={b.label} count={b.count} max={max} />
          ))}
        </div>
      );
    }
  }
}

function QuestionCard({ q }: { q: QuestionDistribution }) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm font-medium">{q.prompt}</CardTitle>
          <Badge variant="secondary" className="shrink-0">
            {QUESTION_TYPE_LABELS[q.type]}
          </Badge>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>{q.sectionTitle}</span>
          <span>
            {q.answeredCount} answered · {pct(q.responseRate)} response rate
          </span>
          <span>avg confidence {confidenceLabel(q.avgConfidence)}</span>
          {q.required && <span className="text-amber-600">required</span>}
        </div>
        {q.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {q.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <DetailBody detail={q.detail} />
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 pt-1 text-[11px]">
          <span>direct {q.provenance.direct}</span>
          <span>inferred {q.provenance.inferred}</span>
          <span>synthesised {q.provenance.synthesised}</span>
          <span>refined {q.provenance.refined}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function QuestionDistributionPanel({ data }: { data: QuestionDistributionsResult | null }) {
  if (!data) {
    return <p className="text-muted-foreground text-sm">Distribution data could not be loaded.</p>;
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {data.totalSessions} session{data.totalSessions === 1 ? '' : 's'} in range ·{' '}
        {data.completedSessions} completed
      </p>
      {data.suppressed && (
        <p className="text-muted-foreground text-sm italic">
          Per-question answer detail is hidden to protect respondent privacy — fewer than{' '}
          {K_ANONYMITY_THRESHOLD} sessions in this window. Response rates return once the sample
          grows.
        </p>
      )}
      {data.questions.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          No questions match the current filter.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.questions.map((q) => (
            <QuestionCard key={q.questionId} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}
