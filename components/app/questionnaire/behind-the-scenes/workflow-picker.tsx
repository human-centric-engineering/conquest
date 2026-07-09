'use client';

/**
 * Workflow picker — a chip row to highlight one pipeline at a time.
 *
 * When a questionnaire lens is active, each chip is tinted by its applicability
 * to that version: `applies` (accent), `inactive` (dimmed), `unavailable`
 * (heavily dimmed). The reason is exposed as a tooltip.
 */

import { cn } from '@/lib/utils';
import type { ApplicabilityStatus, WorkflowSummary } from '@/lib/app/questionnaire/workflows/types';

interface WorkflowPickerProps {
  workflows: WorkflowSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  /** Whether a version lens is active (drives dimming of non-applicable chips). */
  lensActive: boolean;
}

const STATUS_DOT: Record<ApplicabilityStatus, string> = {
  applies: 'bg-emerald-500',
  inactive: 'bg-amber-500',
  unavailable: 'bg-slate-400',
};

export function WorkflowPicker({
  workflows,
  selectedSlug,
  onSelect,
  lensActive,
}: WorkflowPickerProps) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Workflows">
      {workflows.map((w) => {
        const status = w.applicability?.status;
        const dimmed = lensActive && (status === 'inactive' || status === 'unavailable');
        const selected = w.slug === selectedSlug;
        return (
          <button
            key={w.slug}
            type="button"
            role="tab"
            aria-selected={selected}
            title={lensActive ? w.applicability?.reason : w.description}
            onClick={() => onSelect(w.slug)}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
              selected
                ? 'border-[var(--cq-accent)] bg-[var(--cq-accent-muted)] text-[var(--cq-accent)]'
                : 'hover:bg-muted border-border',
              dimmed && 'opacity-45'
            )}
          >
            {lensActive && status ? (
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])}
                aria-hidden
              />
            ) : null}
            {w.title}
          </button>
        );
      })}
    </div>
  );
}
