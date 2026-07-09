'use client';

/**
 * Workflow picker — a category-grouped dropdown to choose one pipeline at a time.
 *
 * Workflows are grouped by the part of ConQuest that runs them (authoring / live
 * conversation / reporting / evaluation — see `workflows/categories.ts`), and each
 * option shows its step count so the reader gets a sense of the pipeline's size
 * before opening it. The trigger echoes the selected workflow's title + step count.
 *
 * When a questionnaire lens is active, each option carries an applicability dot
 * (`applies` = emerald, `inactive` = amber, `unavailable` = slate) and the
 * non-applicable ones are dimmed; the reason rides as a `title` tooltip.
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { WORKFLOW_CATEGORIES } from '@/lib/app/questionnaire/workflows/categories';
import type { ApplicabilityStatus, WorkflowSummary } from '@/lib/app/questionnaire/workflows/types';

interface WorkflowPickerProps {
  workflows: WorkflowSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  /** Whether a version lens is active (drives applicability dots + dimming). */
  lensActive: boolean;
}

const STATUS_DOT: Record<ApplicabilityStatus, string> = {
  applies: 'bg-emerald-500',
  inactive: 'bg-amber-500',
  unavailable: 'bg-slate-400',
};

interface WorkflowGroup {
  id: string;
  label: string;
  workflows: WorkflowSummary[];
}

/**
 * Bucket the summaries into their categories, in the order declared by
 * {@link WORKFLOW_CATEGORIES}. Any diagram not filed under a category (guarded
 * against by the integrity test) still surfaces under a trailing "Other" group,
 * so a mis-categorised workflow is visibly wrong rather than silently missing.
 */
function groupByCategory(workflows: WorkflowSummary[]): WorkflowGroup[] {
  const bySlug = new Map(workflows.map((w) => [w.slug, w]));
  const claimed = new Set<string>();
  const groups: WorkflowGroup[] = [];

  for (const category of WORKFLOW_CATEGORIES) {
    const items: WorkflowSummary[] = [];
    for (const slug of category.slugs) {
      const w = bySlug.get(slug);
      if (w) {
        items.push(w);
        claimed.add(slug);
      }
    }
    if (items.length > 0) {
      groups.push({ id: category.id, label: category.label, workflows: items });
    }
  }

  const leftovers = workflows.filter((w) => !claimed.has(w.slug));
  if (leftovers.length > 0) {
    groups.push({ id: 'other', label: 'Other', workflows: leftovers });
  }

  return groups;
}

function stepLabel(count: number): string {
  return `${count} step${count === 1 ? '' : 's'}`;
}

export function WorkflowPicker({
  workflows,
  selectedSlug,
  onSelect,
  lensActive,
}: WorkflowPickerProps) {
  const groups = groupByCategory(workflows);
  const selected = workflows.find((w) => w.slug === selectedSlug) ?? null;
  const selectedStatus = selected?.applicability?.status;

  return (
    <Select value={selectedSlug ?? undefined} onValueChange={onSelect}>
      <SelectTrigger aria-label="Workflow" className="w-full sm:w-[460px]">
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            {lensActive && selectedStatus ? (
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[selectedStatus])}
                aria-hidden
              />
            ) : null}
            <span className="truncate font-medium">{selected.title}</span>
            <span className="text-muted-foreground shrink-0 text-xs">
              · {stepLabel(selected.stepCount)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select a workflow…</span>
        )}
      </SelectTrigger>

      <SelectContent className="max-h-[70vh] min-w-[320px]">
        {groups.map((group, index) => (
          <SelectGroup key={group.id}>
            {index > 0 ? <SelectSeparator /> : null}
            <SelectLabel className="text-muted-foreground flex items-center justify-between gap-2 text-xs font-semibold tracking-wide uppercase">
              <span>{group.label}</span>
              <span className="font-normal normal-case tabular-nums">{group.workflows.length}</span>
            </SelectLabel>
            {group.workflows.map((w) => {
              const status = w.applicability?.status;
              const dimmed = lensActive && (status === 'inactive' || status === 'unavailable');
              return (
                <SelectItem
                  key={w.slug}
                  value={w.slug}
                  title={lensActive ? w.applicability?.reason : w.description}
                  className={cn(dimmed && 'opacity-50')}
                >
                  <span className="flex w-full items-center gap-2">
                    {lensActive && status ? (
                      <span
                        className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])}
                        aria-hidden
                      />
                    ) : null}
                    <span className="flex-1 truncate">{w.title}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {stepLabel(w.stepCount)}
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
