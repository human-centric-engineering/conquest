/**
 * Shared presentational primitives for the Cohorts & Rounds admin surface.
 *
 * Refined, on-brand building blocks that lift the cohort/round tables and detail pages above
 * plain CRUD — a thin amber completion bar, a live round-status badge with a humanised window
 * phrase, member initials + status pills, and a proper empty state. All pure render (no hooks),
 * so they compose into both client tables and server detail pages. They lean entirely on the
 * `cq-surface` accent tokens (`--cq-accent`, `--cq-accent-muted`), so they stay consistent with
 * the rest of the ConQuest admin and adapt to light/dark automatically.
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { CohortMemberStatus, RoundStatus } from '@/lib/app/questionnaire/rounds';

/* ── Completion bar ──────────────────────────────────────────────────────────── */

export interface CompletionBarProps {
  started: number;
  completed: number;
  rate: number;
  /** Compact = bar + % only (table cells); full adds the "n / m" count (detail/header). */
  variant?: 'compact' | 'full';
  className?: string;
}

/**
 * A thin accent progress bar reading completed ÷ started. Shows an em-dash when nothing has
 * started yet (no misleading 0%). The fill is the surface accent; the track is muted.
 */
export function CompletionBar({
  started,
  completed,
  rate,
  variant = 'compact',
  className,
}: CompletionBarProps) {
  if (started === 0) {
    return <span className="text-muted-foreground text-sm tabular-nums">—</span>;
  }
  const pct = Math.round(rate * 100);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="bg-muted relative h-1.5 w-16 overflow-hidden rounded-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--cq-accent)] transition-[width] duration-500"
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      </div>
      <span className="text-foreground text-xs font-medium tabular-nums">{pct}%</span>
      {variant === 'full' && (
        <span className="text-muted-foreground text-xs tabular-nums">
          {completed} / {started}
        </span>
      )}
    </div>
  );
}

/* ── Round status badge + humanised window ───────────────────────────────────── */

const ROUND_STATUS_STYLE: Record<RoundStatus, { label: string; chip: string; dot: string }> = {
  draft: {
    label: 'Draft',
    chip: 'border-border text-muted-foreground bg-transparent',
    dot: 'bg-muted-foreground/40',
  },
  open: {
    label: 'Open',
    chip: 'border-transparent bg-[color:var(--cq-accent-muted)] text-[color:var(--cq-accent)]',
    dot: 'bg-[color:var(--cq-accent)] cq-livedot',
  },
  closed: {
    label: 'Closed',
    chip: 'border-transparent bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground/50',
  },
};

export function RoundStatusBadge({ status }: { status: RoundStatus }) {
  const s = ROUND_STATUS_STYLE[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        s.chip
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

/** Whole-day difference target − now (UTC-naive, local midnights), for relative phrasing. */
function dayDelta(target: Date, now: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function relativeDay(target: Date, now: Date): string {
  const d = dayDelta(target, now);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 1) return `in ${d} days`;
  return `${-d} days ago`;
}

/**
 * A short, human phrase for a round's window relative to `now` — "Opens tomorrow",
 * "Closes in 5 days", "Closed yesterday", "No end date". Pure; `now` is injected for testability.
 */
export function humanizeWindow(
  status: RoundStatus,
  opensAt: string | null,
  closesAt: string | null,
  now: Date = new Date()
): string {
  if (status === 'closed') return 'Closed';
  const opens = opensAt ? new Date(opensAt) : null;
  const closes = closesAt ? new Date(closesAt) : null;

  if (opens && opens.getTime() > now.getTime()) return `Opens ${relativeDay(opens, now)}`;
  if (closes && closes.getTime() < now.getTime()) return `Window ended ${relativeDay(closes, now)}`;
  if (closes) return `Closes ${relativeDay(closes, now)}`;
  if (status === 'open') return 'No end date';
  return 'Not scheduled';
}

/* ── Member identity ─────────────────────────────────────────────────────────── */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MemberAvatar({ name, dimmed }: { name: string; dimmed?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold',
        dimmed
          ? 'bg-muted text-muted-foreground'
          : 'bg-[color:var(--cq-accent-muted)] text-[color:var(--cq-accent)]'
      )}
    >
      {initials(name)}
    </span>
  );
}

export function MemberStatusPill({ status }: { status: CohortMemberStatus }) {
  const active = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        active
          ? 'bg-[color:var(--cq-accent-muted)] text-[color:var(--cq-accent)]'
          : 'bg-muted text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          active ? 'bg-[color:var(--cq-accent)]' : 'bg-muted-foreground/50'
        )}
      />
      {active ? 'Active' : 'Removed'}
    </span>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────────────── */

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}

/** A centred, inviting empty state — an accent-tinted icon, a headline, copy, and an optional CTA. */
export function CohortEmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--cq-accent-muted)] text-[color:var(--cq-accent)]">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-muted-foreground mx-auto max-w-sm text-xs">{body}</p>
      </div>
      {action}
    </div>
  );
}

/* ── Section heading ─────────────────────────────────────────────────────────── */

/** A consistent sub-section header for the cohort/round surfaces (title + one-line dek). */
export function SectionHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-muted-foreground text-xs">{children}</p>}
    </div>
  );
}
