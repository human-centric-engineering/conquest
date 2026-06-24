'use client';

/**
 * NoticeWhy — a small "Why?" disclosure for the side-band notices (seriousness / contradiction).
 *
 * Reveals the agent's underlying rationale for a notice — the seriousness judge's reason, or a
 * contradiction's explanation — so a respondent (and the demo audience) can see *why* the agent
 * flagged it, without that reasoning shouting from the notice itself. Renders nothing when there's
 * no rationale to show. Presentational only; the text is decided upstream and respondent-safe.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * `children`, when given, render inline on the SAME row as the "Why?" trigger, which flows directly
 * after them (no right-dock); the rationale panel still expands full-width below. Used by the
 * data-slot row to sit "Why?" alongside the confidence/provenance line — it explains the whole
 * reading, so it reads as a row-level affordance, not an annotation on the confidence figure beside
 * it. Without children the component is the original button-only disclosure (the seriousness /
 * contradiction notice cards).
 */
export function NoticeWhy({
  detail,
  children,
  className,
  collapseSignal,
}: {
  detail?: string;
  children?: ReactNode;
  className?: string;
  /**
   * When this number changes, the disclosure closes itself. The answer panel bumps it on scroll and
   * on refetch so an open rationale doesn't linger over content it has scrolled away from or that has
   * since changed. Omit (undefined) to leave the disclosure under purely manual control.
   */
  collapseSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  // Close when the parent signals a collapse (scroll / refetch). Skips the initial mount: the effect's
  // first run carries the starting signal, and `open` already starts closed.
  useEffect(() => {
    if (collapseSignal === undefined) return;
    setOpen(false);
  }, [collapseSignal]);
  const hasDetail = Boolean(detail && detail.trim().length > 0);
  // Nothing to render when there's neither a rationale to disclose nor a cluster to host.
  if (!hasDetail && !children) return null;

  const trigger = hasDetail ? (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] font-medium transition-colors"
    >
      <span>Why?</span>
      <ChevronDown
        className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
        aria-hidden="true"
      />
    </button>
  ) : null;

  return (
    <div className={cn('mt-1.5', className)}>
      {children ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {children}
          {trigger}
        </div>
      ) : (
        trigger
      )}
      {open && hasDetail ? (
        <p className="text-muted-foreground/80 mt-0.5 text-[11px] leading-relaxed italic">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
