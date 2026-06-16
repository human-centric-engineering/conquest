'use client';

/**
 * NoticeWhy — a small "Why?" disclosure for the side-band notices (seriousness / contradiction).
 *
 * Reveals the agent's underlying rationale for a notice — the seriousness judge's reason, or a
 * contradiction's explanation — so a respondent (and the demo audience) can see *why* the agent
 * flagged it, without that reasoning shouting from the notice itself. Renders nothing when there's
 * no rationale to show. Presentational only; the text is decided upstream and respondent-safe.
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export function NoticeWhy({ detail, className }: { detail?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!detail || detail.trim().length === 0) return null;
  return (
    <div className={cn('mt-1.5', className)}>
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
      {open && (
        <p className="text-muted-foreground/80 mt-0.5 text-[11px] leading-relaxed italic">
          {detail}
        </p>
      )}
    </div>
  );
}
