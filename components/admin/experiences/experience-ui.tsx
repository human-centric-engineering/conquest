/**
 * Shared presentational pieces for the Experiences admin surface.
 *
 * Server-renderable (no hooks, no `'use client'`), so both server pages and client tables can use
 * them. Status and kind badges live here rather than in each consumer so the vocabulary renders
 * identically on the list, the workspace header, and the steps editor.
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  EXPERIENCE_KIND_LABELS,
  type ExperienceKind,
  type ExperienceStatus,
  type ExperienceStepKind,
} from '@/lib/app/questionnaire/experiences/types';

/**
 * Status badge. `launched` takes the surface accent (it is the state that matters at a glance);
 * `archived` is deliberately muted so an archived row recedes without being hidden.
 */
export function ExperienceStatusBadge({ status }: { status: ExperienceStatus }) {
  const variant =
    status === 'launched' ? 'default' : status === 'archived' ? 'secondary' : 'outline';
  return (
    <Badge
      variant={variant}
      className={cn(
        'capitalize',
        status === 'launched' &&
          'border-transparent bg-[color:var(--cq-accent)] text-white hover:bg-[color:var(--cq-accent)]',
        status === 'archived' && 'text-muted-foreground'
      )}
    >
      {status}
    </Badge>
  );
}

/** Kind badge — which of the two journey shapes this is. */
export function ExperienceKindBadge({ kind }: { kind: ExperienceKind }) {
  return (
    <Badge variant="outline" className="font-normal">
      {EXPERIENCE_KIND_LABELS[kind]}
    </Badge>
  );
}

/**
 * Step-kind badge. `entry` is accented because exactly one step should carry it and spotting it
 * in a long list is the editor's most common visual task.
 */
export function StepKindBadge({ kind }: { kind: ExperienceStepKind }) {
  return (
    <Badge
      variant={kind === 'entry' ? 'default' : 'outline'}
      className={cn(
        'font-normal capitalize',
        kind === 'entry' &&
          'border-transparent bg-[color:var(--cq-accent)] text-white hover:bg-[color:var(--cq-accent)]'
      )}
    >
      {kind === 'branch' ? 'Branch' : kind}
    </Badge>
  );
}

/** Inviting empty state, matching the cohorts surface's shape. */
export function ExperienceEmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="text-muted-foreground bg-muted flex h-10 w-10 items-center justify-center rounded-full">
        {icon}
      </div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">{body}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The author-facing readiness list. Empty `blockers` renders the ready state instead.
 *
 * Advisory, never blocking: an author reorders and retypes mid-edit, and a hard gate that fires
 * halfway through authoring is an obstacle rather than a guardrail.
 */
export function ExperienceBlockers({ blockers }: { blockers: readonly string[] }) {
  if (blockers.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
        This experience is ready to launch.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Before this experience can run
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-amber-900/90 dark:text-amber-200/90">
        {blockers.map((blocker) => (
          <li key={blocker}>{blocker}</li>
        ))}
      </ul>
    </div>
  );
}
