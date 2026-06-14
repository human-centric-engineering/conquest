'use client';

/**
 * SaveStatus — the structure editor's autosave indicator.
 *
 * The editor has no Save button: every field change fires its own write the moment
 * you blur/toggle it (see {@link VersionEditor}). That was invisible, so editors
 * reasonably asked "where do I save?". This surfaces the truth — a live
 * "Saving… / All changes saved" state — in two places: an `inline` chip in the
 * editor header, and a `floating` pill pinned bottom-right so the reassurance stays
 * on screen while scrolling a long structure.
 *
 * Pure presentation: the parent owns the state machine and the last-saved clock.
 */

import { useEffect, useState } from 'react';
import { Check, CircleAlert, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Coarse relative time ("just now" / "2m ago") that refreshes itself while mounted. */
function RelativeTime({ since }: { since: number }) {
  // Read the clock in an effect, not during render (render must stay pure).
  const [label, setLabel] = useState('just now');
  useEffect(() => {
    const compute = () => {
      const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
      setLabel(
        secs < 8 ? 'just now' : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`
      );
    };
    compute();
    const id = setInterval(compute, 20_000);
    return () => clearInterval(id);
  }, [since]);
  return <span className="tabular-nums">{label}</span>;
}

function statusBits(state: SaveState) {
  switch (state) {
    case 'saving':
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
        text: 'Saving…',
        tone: 'text-[var(--cq-accent)]',
      };
    case 'saved':
      return {
        icon: <Check className="h-3.5 w-3.5" />,
        text: 'All changes saved',
        tone: 'text-emerald-600 dark:text-emerald-400',
      };
    case 'error':
      return {
        icon: <CircleAlert className="h-3.5 w-3.5" />,
        text: 'Couldn’t save — try again',
        tone: 'text-destructive',
      };
    case 'idle':
      return {
        icon: <Check className="h-3.5 w-3.5 opacity-50" />,
        text: 'Changes save automatically',
        tone: 'text-muted-foreground',
      };
  }
}

export function SaveStatus({
  state,
  lastSavedAt,
  variant = 'inline',
}: {
  state: SaveState;
  /** Epoch ms of the last successful save, or null if none yet this session. */
  lastSavedAt: number | null;
  variant?: 'inline' | 'floating';
}) {
  const { icon, text, tone } = statusBits(state);
  const showClock = state === 'saved' && lastSavedAt !== null;

  const body = (
    <>
      <span className={cn('flex items-center gap-1.5 font-medium', tone)}>
        {icon}
        {text}
      </span>
      {showClock ? (
        <span className="text-muted-foreground">
          · <RelativeTime since={lastSavedAt} />
        </span>
      ) : null}
    </>
  );

  if (variant === 'floating') {
    return (
      <div
        aria-live="polite"
        className={cn(
          'bg-card/95 fixed right-6 bottom-6 z-20 flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs shadow-lg backdrop-blur',
          state === 'saving' && 'cq-pulse'
        )}
      >
        {body}
      </div>
    );
  }

  return (
    <div aria-live="polite" className="flex items-center gap-1.5 text-xs">
      {body}
    </div>
  );
}
