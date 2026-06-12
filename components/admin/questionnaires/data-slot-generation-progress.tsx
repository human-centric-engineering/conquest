'use client';

/**
 * Live progress view for streaming (map-reduce) data-slot generation.
 *
 * Shows each section as it's analysed — a running spinner, then the slot names that
 * section produced appearing as chips — followed by the reconcile (merge) phase. Purely
 * presentational; the parent owns the state and feeds it from the SSE stream.
 */

import { AlertTriangle, Check, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { GeneratedDataSlot } from '@/lib/app/questionnaire/data-slots';

export type SectionStatus = 'running' | 'done' | 'error';

export interface SectionProgress {
  index: number;
  title: string;
  questionCount: number;
  status: SectionStatus;
  slots: GeneratedDataSlot[];
  message?: string;
}

export interface DataSlotGenProgress {
  phase: 'mapping' | 'merging';
  totalQuestions: number;
  sections: SectionProgress[];
  /** Candidate slot count entering the merge step. */
  rawSlotCount?: number;
  /** Set when automatic reconciliation failed and the combined set is shown instead. */
  mergeWarning?: string;
}

function SectionIcon({ status }: { status: SectionStatus }) {
  if (status === 'done') return <Check className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === 'error') return <AlertTriangle className="text-destructive h-4 w-4 shrink-0" />;
  return <Loader2 className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />;
}

export function DataSlotGenerationProgress({ progress }: { progress: DataSlotGenProgress }) {
  const total = progress.sections.length;
  const done = progress.sections.filter((s) => s.status !== 'running').length;
  const slotsSoFar = progress.sections.reduce((n, s) => n + s.slots.length, 0);
  const merging = progress.phase === 'merging';

  return (
    <div className="bg-muted/20 space-y-3 rounded-lg border p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="text-primary h-4 w-4 animate-spin" />
          {merging ? 'Reconciling sections into a final set…' : 'Analysing sections…'}
        </div>
        <span className="text-muted-foreground text-xs">
          {merging
            ? `Merging ${progress.rawSlotCount ?? slotsSoFar} proposed slots`
            : `${done}/${total} sections · ${slotsSoFar} slot${slotsSoFar === 1 ? '' : 's'} so far`}
        </span>
      </div>

      <ul className="space-y-2">
        {progress.sections.map((s) => (
          <li
            key={s.index}
            className={cn(
              'bg-background rounded-md border p-3',
              merging && 'opacity-70',
              s.status === 'error' && 'border-destructive/40'
            )}
          >
            <div className="flex items-center gap-2">
              <SectionIcon status={s.status} />
              <span className="text-sm font-medium">{s.title}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {s.status === 'done'
                  ? `${s.slots.length} slot${s.slots.length === 1 ? '' : 's'}`
                  : s.status === 'error'
                    ? 'failed'
                    : `${s.questionCount} question${s.questionCount === 1 ? '' : 's'}…`}
              </span>
            </div>

            {s.slots.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.slots.map((slot, i) => (
                  <span
                    key={`${slot.name}-${i}`}
                    title={slot.description}
                    className="bg-primary/5 rounded-md border px-2 py-0.5 text-xs"
                  >
                    {slot.name}
                  </span>
                ))}
              </div>
            )}

            {s.status === 'error' && s.message && (
              <p className="text-destructive mt-1.5 text-xs">{s.message}</p>
            )}
          </li>
        ))}
      </ul>

      {progress.mergeWarning && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{progress.mergeWarning}</p>
      )}
    </div>
  );
}
